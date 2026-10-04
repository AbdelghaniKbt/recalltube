import { browser } from "wxt/browser";
import {
  loadLatestPlaylistJob,
  loadPlaylistJob,
  loadPlaylistJobsOwningWorkers,
  loadResumablePlaylistJobs,
  loadTranscriptForVideo,
  savePlaylistInventory,
  savePlaylistJob,
  saveTranscript,
} from "../storage/indexeddb";
import type { ContentResponse } from "../types/messages";
import type { PlaylistIndexJob, PlaylistVideo } from "../types/playlist";
import type { AcquisitionFailureReason, AdapterDiagnostic, PageSnapshot, TranscriptDocument } from "../types/transcript";
import {
  createPlaylistJob,
  finalizeJob,
  markItemFailed,
  markItemIndexing,
  markItemReady,
  nextPendingItem,
  requeueForAutomaticRetry,
  resetInterruptedItem,
  resetRetryableItems,
} from "./job";
import { parsePlaylistCommand, type PlaylistCommand, type PlaylistCommandResponse } from "./messages";
import { videoWatchUrl } from "./url";

/** Mirrors the key the side panel records its temporary inventory tab under. */
const INVENTORY_TAB_KEY = "recalltube:inventory-tab";

const ACQUISITION_TIMEOUT_MS = 55_000;
const POLL_MS = 500;
const BETWEEN_VIDEOS_MS = 900;

/**
 * Native-stage waiting is progress-based. A fixed 55 s turned a slow but advancing capture — 50 s
 * measured at 4x CPU and 300 ms latency — into a failure that a manual retry then recovered.
 */
const timing = {
  /** No reported progress for this long means the native stage has stalled. */
  nativeStallMs: 45_000,
  /** Absolute bound on one native attempt, however steadily it advances. */
  nativeCapMs: 240_000,
  /** Pause before an automatic retry pass, so a transient condition can clear. */
  retryPassDelayMs: 5_000,
  /** How long a worker page may report itself hidden before it is brought to the front. */
  hiddenBeforeFocusMs: 5_000,
};

/** Test hook: shortens the waiting limits above. */
export function setCoordinatorTimingForTest(overrides: Partial<typeof timing>): void {
  Object.assign(timing, overrides);
}

const controllers = new Map<string, AbortController>();
/**
 * One in-flight run per job, chained rather than dropped.
 *
 * `processJob` used to refuse to start when a controller for the job existed and delete that
 * controller at the *top* of its `finally`, before closing the worker. A resume arriving in that
 * window therefore passed the guard, created a second worker, and the previous run's cleanup then
 * closed the wrong tab and wrote its own stale ownership over the new one — two workers for one
 * job, one of them leaked. Serializing the runs removes the window entirely.
 */
const runs = new Map<string, Promise<void>>();

function startJob(jobId: string): void {
  const next = (runs.get(jobId) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => processJob(jobId))
    .finally(() => {
      if (runs.get(jobId) === next) runs.delete(jobId);
    });
  runs.set(jobId, next);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

/**
 * Retries Chrome's transient "Tabs cannot be edited right now (user may be dragging a tab)".
 *
 * Chrome rejects tab and window edits while a window is changing state. Live, restoring the worker
 * window for the native stage hit exactly that, and the uncaught rejection failed the item as a
 * network error. Only that rejection is retried, a bounded number of times.
 */
async function withTransientRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const transient = error instanceof Error && /cannot be edited right now/iu.test(error.message);
      if (!transient || attempt >= 9) throw error;
      await wait(150 * (attempt + 1));
    }
  }
}

async function publish(job: PlaylistIndexJob): Promise<void> {
  await savePlaylistJob(job);
  await browser.runtime
    .sendMessage({ type: "recalltube:playlist-job-changed", job })
    .catch(() => undefined);
}

async function closeWorker(job: PlaylistIndexJob): Promise<PlaylistIndexJob> {
  if (job.workerWindowId !== undefined && (await windowHoldsOnlyOwnedWorkers(job.workerWindowId))) {
    await browser.windows.remove(job.workerWindowId).catch(() => undefined);
  }
  // Some Chromium builds acknowledge window removal before (or without) removing its final tab.
  // The tab id is extension-owned and persisted with the job, so a second idempotent close is safe.
  if (job.workerTabId !== undefined) {
    for (let attempt = 0; attempt < 5 && (await workerExists(job.workerTabId)); attempt += 1) {
      await browser.tabs.remove(job.workerTabId).catch(() => undefined);
      await wait(100);
    }
    if (await workerExists(job.workerTabId)) {
      return {
        ...job,
        workerWindowId: undefined,
        lastError: "Chrome did not close the extension-owned playlist worker tab.",
        updatedAt: Date.now(),
      };
    }
    await forgetOwnedWorker(job.workerTabId);
  }
  // Focus is restored only when the worker is known to have taken it, and only to the window that
  // had it. This used to focus the owner tab's window after *every* item — pulling Chrome to the
  // front on each video even when the user had moved to another window or application.
  if (job.restoreFocusWindowId !== undefined) {
    await browser.windows.update(job.restoreFocusWindowId, { focused: true }).catch(() => undefined);
  }
  return {
    ...job,
    workerTabId: undefined,
    workerWindowId: undefined,
    restoreFocusWindowId: undefined,
    updatedAt: Date.now(),
  };
}

/**
 * Tab ids this extension actually created, scoped to the current browser session.
 *
 * A job's `workerTabId` is persisted in IndexedDB, which outlives both the service worker and the
 * browser. Chrome hands out tab ids from a counter that restarts with the browser, so a persisted
 * id from an earlier session can name a tab the *user* opened — and `navigateWorker` would then
 * drive that tab to another video while `closeWorker` would close it. Nothing in the tabs API
 * attributes a tab to its creator, so ownership is recorded here instead, in `storage.session`,
 * which Chrome clears on browser restart. An id we cannot vouch for is treated as gone.
 */
const OWNED_WORKERS_KEY = "recalltube:owned-workers";

/**
 * The owned ids, or `undefined` when the session store cannot answer.
 *
 * The distinction matters: an empty record means "this browser session created no worker", which is
 * a reason to disown a persisted id, whereas an unavailable store means we simply do not know — and
 * treating *that* as "not ours" would make the coordinator open a fresh tab for every video and
 * close none of them.
 */
async function ownedWorkerIds(): Promise<number[] | undefined> {
  try {
    const stored = await browser.storage.session.get(OWNED_WORKERS_KEY);
    const value = stored?.[OWNED_WORKERS_KEY];
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value.filter((id): id is number => typeof id === "number") : [];
  } catch {
    return undefined;
  }
}

async function rememberOwnedWorker(tabId: number): Promise<void> {
  const owned = await ownedWorkerIds();
  if (owned?.includes(tabId)) return;
  try {
    // Bounded: one worker at a time, plus room for ids whose tabs Chrome closed behind our back.
    await browser.storage.session.set({ [OWNED_WORKERS_KEY]: [...(owned ?? []), tabId].slice(-8) });
  } catch {
    // Unverifiable ownership degrades to the pre-existing behaviour, never to a tab leak.
  }
}

async function forgetOwnedWorker(tabId: number): Promise<void> {
  const owned = await ownedWorkerIds();
  if (!owned) return;
  try {
    await browser.storage.session.set({ [OWNED_WORKERS_KEY]: owned.filter((id) => id !== tabId) });
  } catch {
    // See above.
  }
}

/**
 * Whether a recorded worker window may be closed: it must exist and every tab in it must be a
 * session-owned worker. A window id is persisted like a tab id, so a stale or wrong id must never be
 * able to close a window holding the user’s tabs; in that case only the owned tab is closed.
 */
async function windowHoldsOnlyOwnedWorkers(windowId: number): Promise<boolean> {
  const window = await browser.windows.get(windowId, { populate: true }).catch(() => undefined);
  const tabIds = window?.tabs?.map((tab) => tab.id) ?? [];
  if (!tabIds.length) return false;
  const owned = await ownedWorkerIds();
  if (!owned) return false;
  return tabIds.every((id) => id !== undefined && owned.includes(id));
}

/** True only for a live tab this extension created in this browser session. */
async function workerExists(tabId: number | undefined): Promise<boolean> {
  if (tabId === undefined) return false;
  const owned = await ownedWorkerIds();
  if (owned && !owned.includes(tabId)) return false;
  return Boolean(await browser.tabs.get(tabId).catch(() => undefined));
}

async function navigateWorker(job: PlaylistIndexJob, item: PlaylistVideo): Promise<PlaylistIndexJob> {
  const url = videoWatchUrl(item.videoId);
  let tabId = job.workerTabId;
  let workerWindowId = job.workerWindowId;
  if (!(await workerExists(tabId))) {
    // Establish the extension-owned window before navigating it. Passing the YouTube URL directly
    // to windows.create lets navigation race window attachment: in Chromium the request can start
    // against an initial, half-attached document and never build the native transcript controls.
    // The about:blank handoff gives the final watch document a stable active-tab/window lifecycle,
    // matching a user-opened single-video tab without touching the user's browsing window.
    const workerWindow = await browser.windows.create({
      focused: false,
      state: "minimized",
      type: "popup",
      url: "about:blank",
    });
    if (!workerWindow || workerWindow.id === undefined) {
      throw new Error("Chrome did not create the playlist worker window.");
    }
    const tab = workerWindow.tabs?.[0] ?? (await browser.tabs.query({ windowId: workerWindow.id }))[0];
    if (tab?.id === undefined) throw new Error("Chrome did not create the playlist worker tab.");
    await rememberOwnedWorker(tab.id);
    tabId = tab.id;
    workerWindowId = workerWindow.id;
    // Some Chromium builds accept `state: minimized` during creation but return a normal window.
    // Enforce it after the id exists so direct caption requests stay out of the user's way.
    if (workerWindow.state !== "minimized") {
      await browser.windows.update(workerWindow.id, { focused: false, state: "minimized" }).catch(() => undefined);
    }
  }
  if (tabId === undefined) throw new Error("The playlist worker tab disappeared.");
  const workerTab = tabId;
  await withTransientRetry(() =>
    browser.tabs.update(workerTab, {
      active: workerWindowId !== undefined,
      autoDiscardable: false,
      muted: true,
      url,
    })
  ).catch(() => undefined);
  const current = await browser.tabs.get(tabId).catch(() => undefined);
  if (current?.discarded) await browser.tabs.reload(tabId);
  return { ...job, workerTabId: tabId, workerWindowId, updatedAt: Date.now() };
}

/**
 * Size and place of the worker window while it must render. Wide enough for YouTube's watch layout
 * to build its description and transcript control (the narrow layout still has both), small enough
 * to sit in the bottom-right corner of the window that had focus instead of covering it.
 */
const WORKER_WINDOW = { width: 720, height: 540, margin: 24 } as const;

export function workerBoundsNear(
  reference: { left?: number; top?: number; width?: number; height?: number } | undefined
): { width: number; height: number; left?: number; top?: number } {
  const { width, height, margin } = WORKER_WINDOW;
  if (!reference || reference.left === undefined || reference.top === undefined || !reference.width || !reference.height) {
    return { width, height };
  }
  return {
    width,
    height,
    left: Math.max(0, reference.left + reference.width - width - margin),
    top: Math.max(0, reference.top + reference.height - height - margin),
  };
}

async function promoteWorkerForNativePanel(job: PlaylistIndexJob): Promise<PlaylistIndexJob> {
  if (job.workerTabId === undefined) return job;
  const workerTab = job.workerTabId;
  if (job.workerWindowId !== undefined) {
    await withTransientRetry(() => browser.tabs.update(workerTab, { active: true, autoDiscardable: false, muted: true }));
    return job;
  }
  // Compatibility recovery for a job persisted by an older build that created an inactive tab.
  const workerWindow = await browser.windows.create({
    focused: false,
    type: "popup",
    tabId: job.workerTabId,
  });
  if (!workerWindow || workerWindow.id === undefined) {
    throw new Error("Chrome could not promote the playlist worker for native transcript capture.");
  }
  await withTransientRetry(() => browser.tabs.update(workerTab, { active: true, autoDiscardable: false, muted: true }));
  return { ...job, workerWindowId: workerWindow.id, updatedAt: Date.now() };
}

async function readTranscript(
  tabId: number,
  videoId: string,
  signal: AbortSignal,
  minimumGeneration = 0
): Promise<PageSnapshot> {
  const deadline = Date.now() + ACQUISITION_TIMEOUT_MS;
  let askedToRefresh = false;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (!(await workerExists(tabId))) {
      return { status: "failed", videoId, generation: 0, reason: "tab-not-connected" };
    }
    const response = await (browser.tabs.sendMessage(tabId, { type: "recalltube:get-state" }) as Promise<ContentResponse>)
      .catch(() => undefined);
    if (response?.ok && response.snapshot?.videoId === videoId && response.snapshot.generation >= minimumGeneration) {
      const snapshot = response.snapshot;
      if (snapshot.status === "ready" && snapshot.document) return snapshot;
      if (snapshot.status === "failed") {
        if (!askedToRefresh && snapshot.reason === "not-ready") {
          askedToRefresh = true;
          // Worker pages never open YouTube UI during the hidden direct stage. Native capture is a
          // separate, coordinator-owned transition after the worker is rendered and focused.
          await browser.tabs
            .sendMessage(tabId, { type: "recalltube:refresh", acquisitionMode: "direct-only" })
            .catch(() => undefined);
        } else if (snapshot.reason && snapshot.reason !== "not-ready") {
          return snapshot;
        }
      }
    }
    await wait(POLL_MS, signal);
  }
  return { status: "failed", videoId, generation: 0, reason: "not-ready" };
}

/**
 * The item's failure reason from both stages.
 *
 * The direct stage has the stronger evidence about whether captions exist: it reads the player's
 * advertised caption tracks. When it saw a track, a native stage that found no transcript control is
 * not evidence of "no captions" — live, a slow page simply had not built the control yet, and
 * reporting "no-captions" made those videos terminal and never retried.
 */
export function combinedFailureReason(
  directFailure: AcquisitionFailureReason | undefined,
  nativeFailure: AcquisitionFailureReason | undefined
): AcquisitionFailureReason {
  if (directFailure === "captions-withheld" && (nativeFailure === "no-captions" || nativeFailure === "not-ready" || !nativeFailure)) {
    return "captions-withheld";
  }
  if (nativeFailure === "not-ready" || !nativeFailure) return directFailure ?? nativeFailure ?? "network-error";
  return nativeFailure;
}

/** Replaced documents get the native request again, at most this many requests per item. */
const MAX_NATIVE_REQUESTS = 3;

/**
 * Starts the native-panel attempt and waits for *its* outcome.
 *
 * Restoring a minimized worker sometimes replaces its page. Live, the request then went to the
 * discarded document while the new document ran its own direct-only attempt from generation 1, and
 * waiting for "generation >= 2" hung for the full timeout on 5 of 10 playlist items. A generation is
 * therefore tracked together with the document that issued it, and a replaced document is asked again.
 */
async function readNativeTranscript(
  tabId: number,
  videoId: string,
  signal: AbortSignal,
  directGeneration: number,
  /** Called once if the page keeps reporting itself hidden while it waits for YouTube to render. */
  onHidden?: () => Promise<void>
): Promise<PageSnapshot> {
  let hiddenSince: number | undefined;
  let escalated = false;
  const hardDeadline = Date.now() + timing.nativeCapMs;
  let stallDeadline = Date.now() + timing.nativeStallMs;
  let lastProgress = "";
  let expected: { documentId?: string; generation: number } | undefined;
  let requests = 0;
  let last: PageSnapshot | undefined;
  while (Date.now() < Math.min(hardDeadline, stallDeadline)) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (!(await workerExists(tabId))) {
      return { status: "failed", videoId, generation: 0, reason: "tab-not-connected" };
    }
    if (!expected) {
      if (requests >= MAX_NATIVE_REQUESTS) break;
      const started = await (browser.tabs.sendMessage(tabId, {
        type: "recalltube:refresh",
        acquisitionMode: "native-panel",
      }) as Promise<ContentResponse>).catch(() => undefined);
      if (started?.ok) {
        requests += 1;
        // A content script from an older build acknowledges without a generation; the best it
        // allows is "newer than the direct attempt".
        expected =
          typeof started.generation === "number"
            ? { documentId: started.documentId, generation: started.generation }
            : { generation: directGeneration + 1 };
      } else {
        // A replacement document whose content script has not registered yet.
        await wait(POLL_MS, signal);
        continue;
      }
    }
    const response = await (browser.tabs.sendMessage(tabId, { type: "recalltube:get-state" }) as Promise<ContentResponse>)
      .catch(() => undefined);
    if (response?.ok && response.snapshot?.videoId === videoId) {
      if (expected.documentId && response.documentId && response.documentId !== expected.documentId) {
        expected = undefined;
        continue;
      }
      const snapshot = response.snapshot;
      if (snapshot.generation >= expected.generation) {
        last = snapshot;
        // Any change in reported phase or row count is progress and restarts the stall limit.
        // `progress.at` is included: the page reports a heartbeat while YouTube's own loader is
        // still shown, which is progress even though phase and row count are unchanged.
        const progress = `${snapshot.generation}:${snapshot.status}:${snapshot.progress?.phase ?? ""}:${snapshot.progress?.rows ?? ""}:${snapshot.progress?.at ?? ""}`;
        if (progress !== lastProgress) {
          lastProgress = progress;
          stallDeadline = Date.now() + timing.nativeStallMs;
        }
        // A hidden page does not render YouTube’s transcript rows. Bringing the worker to the front
        // is the one case where taking focus is required, so it happens only on this measured signal.
        if (snapshot.status === "loading" && snapshot.progress?.hidden) {
          hiddenSince ??= Date.now();
          if (!escalated && onHidden && Date.now() - hiddenSince >= timing.hiddenBeforeFocusMs) {
            escalated = true;
            await onHidden().catch(() => undefined);
          }
        } else {
          hiddenSince = undefined;
        }
        if (snapshot.status === "ready" && snapshot.document) return snapshot;
        if (snapshot.status === "failed" && snapshot.reason && snapshot.reason !== "not-ready") return snapshot;
      }
    }
    await wait(POLL_MS, signal);
  }
  return last ?? { status: "failed", videoId, generation: 0, reason: "not-ready" };
}

async function acquireItem(
  job: PlaylistIndexJob,
  item: PlaylistVideo,
  signal: AbortSignal
): Promise<{
  job: PlaylistIndexJob;
  document?: TranscriptDocument;
  reason?: AcquisitionFailureReason;
  diagnostics?: AdapterDiagnostic[];
}> {
  const cached = await loadTranscriptForVideo(item.videoId);
  if (cached) {
    return { job: markItemReady(job, item.videoId, cached.document, true), document: cached.document };
  }
  let next = markItemIndexing(job, item.videoId);
  await publish(next);
  next = await navigateWorker(next, item);
  await publish(next);
  let snapshot = await readTranscript(next.workerTabId!, item.videoId, signal);
  const directFailure = snapshot.status === "failed" ? snapshot.reason : undefined;
  // A terminal direct failure (the player reports the video removed, private or not started) has no
  // native stage: there is no transcript control to render, so the worker is never shown for it.
  if (snapshot.status === "failed" && snapshot.reason !== "tab-not-connected" && !snapshot.terminal) {
    // Measured on 2026-09-16 (Chromium 151, same 732-row video): a minimized worker never builds
    // YouTube's transcript control, while an unfocused *normal* window and a focused one both
    // capture every row. Rendering is required; focus is not, so it is never requested.
    const focusedBefore = await browser.windows.getLastFocused().catch(() => undefined);
    next = await promoteWorkerForNativePanel(next);
    if (next.workerWindowId !== undefined) {
      const workerWindow = next.workerWindowId;
      // Rendered in a small window tucked into a corner of the user's window: still a full watch
      // page with its description and transcript control, but a fraction of the screen a
      // default-size popup took, and never over the user's content.
      const bounds = workerBoundsNear(focusedBefore);
      await withTransientRetry(() =>
        browser.windows.update(workerWindow, { focused: false, state: "normal", ...bounds })
      ).catch(() => undefined);
      // Some window managers activate a restored window regardless of `focused: false`. Persist
      // where focus was so every cleanup path — including after an exception — can give it back.
      const focusedAfter = await browser.windows.getLastFocused().catch(() => undefined);
      if (
        focusedAfter?.focused &&
        focusedAfter.id === next.workerWindowId &&
        focusedBefore?.id !== undefined &&
        focusedBefore.id !== next.workerWindowId
      ) {
        next = { ...next, restoreFocusWindowId: focusedBefore.id, updatedAt: Date.now() };
      }
    }
    await publish(next);
    const prepared = await (browser.tabs.sendMessage(next.workerTabId!, {
      type: "recalltube:prepare-native",
    }) as Promise<ContentResponse>).catch(() => undefined);
    // A response from the prior document is stale even if Chrome delivered it during a tab move.
    // The native adapter still gets one attempt when YouTube exposes no control, so it can expand
    // a late description section and classify a genuinely unavailable transcript itself.
    if (prepared?.ok && prepared.videoId && prepared.videoId !== item.videoId) {
      throw new Error("Playlist worker changed video before native transcript capture.");
    }
    snapshot = await readNativeTranscript(next.workerTabId!, item.videoId, signal, snapshot.generation, async () => {
      if (next.workerWindowId === undefined) return;
      const before = await browser.windows.getLastFocused().catch(() => undefined);
      const workerWindow = next.workerWindowId;
      await withTransientRetry(() => browser.windows.update(workerWindow, { focused: true, state: "normal" }));
      if (before?.id !== undefined && before.id !== workerWindow && next.restoreFocusWindowId === undefined) {
        next = { ...next, restoreFocusWindowId: before.id, updatedAt: Date.now() };
        await publish(next);
      }
    });
  }
  if (snapshot.status === "ready" && snapshot.document) {
    await saveTranscript(snapshot.document);
    return { job: markItemReady(next, item.videoId, snapshot.document, false), document: snapshot.document };
  }
  return {
    job: next,
    reason: combinedFailureReason(directFailure, snapshot.reason),
    diagnostics: snapshot.diagnostics,
  };
}

async function processJob(jobId: string): Promise<void> {
  const controller = new AbortController();
  controllers.set(jobId, controller);
  let job = await loadPlaylistJob(jobId);
  if (!job) {
    controllers.delete(jobId);
    return;
  }

  try {
    while (!controller.signal.aborted) {
      // Claim the job only from a fresh read. A run chained behind a previous one starts after the
      // user has had time to act, and stamping "running" up front — from a snapshot loaded before
      // that — made the next iteration read back the state this run had just written, resurrecting
      // a job the user had paused or cancelled and opening a worker for it.
      const persisted = await loadPlaylistJob(jobId);
      if (!persisted) break;
      if (persisted.state === "paused" || persisted.state === "cancelled" || persisted.state === "completed") break;
      job = persisted;
      if (job.state !== "running") {
        job = { ...job, state: "running", startedAt: job.startedAt ?? Date.now(), updatedAt: Date.now() };
        await publish(job);
      }
      const item = nextPendingItem(job);
      if (!item) {
        const retryPass = requeueForAutomaticRetry(job);
        if (retryPass !== job) {
          job = retryPass;
          await publish(job);
          await wait(timing.retryPassDelayMs, controller.signal);
          continue;
        }
        job = finalizeJob(job);
        await publish(job);
        break;
      }
      try {
        const result = await acquireItem(job, item, controller.signal);
        job = result.reason
          ? markItemFailed(result.job, item.videoId, result.reason, Date.now(), result.diagnostics)
          : result.job;
      } catch (error) {
        if (controller.signal.aborted) break;
        // `acquireItem` persists worker ownership before navigation. Reload it here so an exception
        // cannot overwrite those ids with the caller's older snapshot and leak the worker.
        job = markItemFailed((await loadPlaylistJob(jobId)) ?? job, item.videoId, "network-error");
        job = { ...job, lastError: error instanceof Error ? error.message.slice(0, 500) : "Indexing failed." };
      }
      await publish(job);

      // A fresh document per video is deliberate. Reusing a YouTube tab carries player, transcript
      // panel and SPA state from the previous video; single-video capture never has that state and
      // proved materially more reliable. Close after each item so native UI and its window cannot
      // leak into the next acquisition.
      const cleaned = await closeWorker(job);
      const current = (await loadPlaylistJob(jobId)) ?? cleaned;
      job = {
        ...current,
        workerTabId: cleaned.workerTabId,
        workerWindowId: cleaned.workerWindowId,
        restoreFocusWindowId: cleaned.restoreFocusWindowId,
        lastError: cleaned.lastError ?? current.lastError,
        updatedAt: Date.now(),
      };
      await publish(job);
      if (job.state === "paused" || job.state === "cancelled") break;
      await wait(BETWEEN_VIDEOS_MS, controller.signal);
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      job = { ...job, state: "failed", lastError: error instanceof Error ? error.message.slice(0, 500) : "Indexing failed.", updatedAt: Date.now() };
      await publish(job);
    }
  } finally {
    const latest = (await loadPlaylistJob(jobId)) ?? job;
    // Close what *this run* created, not merely what storage happens to say now. A command handled
    // while the run was unwinding can have rewritten the record, and an id this run owns that the
    // record no longer mentions is precisely the tab nothing else will ever close.
    const cleaned = await closeWorker({
      ...latest,
      workerTabId: latest.workerTabId ?? job.workerTabId,
      workerWindowId: latest.workerWindowId ?? job.workerWindowId,
      restoreFocusWindowId: latest.restoreFocusWindowId ?? job.restoreFocusWindowId,
    });
    // Closing a worker takes several hundred milliseconds, during which a pause or cancel can
    // land. Re-read and carry only the ownership fields forward so cleanup can never restore a
    // state the user has already moved past.
    const current = (await loadPlaylistJob(jobId)) ?? cleaned;
    await publish({
      ...current,
      workerTabId: cleaned.workerTabId,
      workerWindowId: cleaned.workerWindowId,
      restoreFocusWindowId: cleaned.restoreFocusWindowId,
      lastError: cleaned.lastError ?? current.lastError,
      updatedAt: Date.now(),
    });
    // Released last: a resume is chained behind this run, so the controller stays addressable for
    // the whole of cleanup and no second run can overlap it.
    controllers.delete(jobId);
  }
}

async function handle(command: PlaylistCommand): Promise<PlaylistCommandResponse> {
  switch (command.type) {
    case "recalltube:playlist-get":
      return { ok: true, job: await loadLatestPlaylistJob(command.playlistId) };
    case "recalltube:playlist-start": {
      // Keep one acquisition worker globally. Starting a new playlist is an explicit hand-off,
      // not permission to leave multiple hidden YouTube players consuming resources.
      const activeJobs = await loadResumablePlaylistJobs();
      for (const active of activeJobs) {
        controllers.get(active.jobId)?.abort();
        const cancelled = await closeWorker({
          ...active,
          state: "cancelled",
          finishedAt: Date.now(),
          updatedAt: Date.now(),
        });
        await publish(cancelled);
      }
      await savePlaylistInventory(command.inventory);
      const job = createPlaylistJob(command.inventory, { ownerTabId: command.ownerTabId });
      await publish(job);
      startJob(job.jobId);
      return { ok: true, job };
    }
    case "recalltube:playlist-pause": {
      const job = await loadPlaylistJob(command.jobId);
      if (!job) return { ok: false, error: "Playlist indexing job not found." };
      const paused = { ...job, state: "paused" as const, updatedAt: Date.now() };
      await publish(paused);
      controllers.get(job.jobId)?.abort();
      return { ok: true, job: paused };
    }
    case "recalltube:playlist-cancel": {
      const job = await loadPlaylistJob(command.jobId);
      if (!job) return { ok: false, error: "Playlist indexing job not found." };
      const cancelled = { ...job, state: "cancelled" as const, finishedAt: Date.now(), updatedAt: Date.now() };
      await publish(cancelled);
      controllers.get(job.jobId)?.abort();
      return { ok: true, job: cancelled };
    }
    case "recalltube:playlist-resume":
    case "recalltube:playlist-retry": {
      const job = await loadPlaylistJob(command.jobId);
      if (!job) return { ok: false, error: "Playlist indexing job not found." };
      // `resetInterruptedItem` and `resetRetryableItems` forget the recorded worker ids. If the
      // service worker was suspended mid-cleanup the job is `paused`, which the restart sweep does
      // not revisit, so forgetting without closing orphans a YouTube tab the user never opened.
      // When a run is still active its own `finally` owns cleanup; only an abandoned worker is
      // ours to close here.
      const released = controllers.has(job.jobId) ? job : await closeWorker(job);
      const resumed = command.type === "recalltube:playlist-retry"
        ? resetRetryableItems(released)
        : resetInterruptedItem(released);
      await publish(resumed);
      startJob(resumed.jobId);
      return { ok: true, job: resumed };
    }
  }
}

/** Exposed for the worker-ownership regression tests, which drive the real command handler. */
export const handlePlaylistCommandForTest = handle;

/**
 * Whether the sending tab is a playlist worker this extension created in this browser session.
 *
 * The content script uses this to run the direct-only first stage. It replaced a
 * `#recalltube-playlist-worker` URL fragment, which any link could carry: an ordinary user tab
 * opened from such a link silently lost its native-transcript fallback.
 */
export async function isOwnedWorkerTab(tabId: number | undefined): Promise<boolean> {
  if (tabId === undefined) return false;
  const owned = await ownedWorkerIds();
  return Boolean(owned?.includes(tabId));
}

export function registerPlaylistCoordinator(): void {
  browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse): boolean => {
    if (sender.id && sender.id !== browser.runtime.id) return false;
    if (raw && typeof raw === "object" && (raw as { type?: unknown }).type === "recalltube:worker-role") {
      void isOwnedWorkerTab(sender.tab?.id)
        .then((worker) => sendResponse({ ok: true, worker }))
        .catch(() => sendResponse({ ok: true, worker: false }));
      return true;
    }
    const command = parsePlaylistCommand(raw);
    if (!command) return false;
    void handle(command)
      .then(sendResponse)
      .catch((error: unknown) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "Playlist command failed." })
      );
    return true;
  });

  // A running job represents explicit user intent. Recover after MV3 suspension and reset only the
  // item that was interrupted; terminal failures remain visible instead of looping forever.
  //
  // Cleanup is wider than recovery on purpose: a job suspended while paused, cancelled or finished
  // can still record a worker that outlived the service worker, and nothing else will ever revisit
  // it. Closing by the persisted tab/window id can only ever touch a tab this extension created.
  void loadPlaylistJobsOwningWorkers().then((owning) => {
    for (const job of owning) {
      void closeWorker(job).then((cleaned) => savePlaylistJob(cleaned));
    }
  });

  // The side panel creates one temporary tab to read a lazily-paginated playlist, and Chrome
  // destroys the panel without warning whenever the user closes it. The id it records is the only
  // handle left, so close it here too — by id, never by URL.
  void browser.storage.session
    .get(INVENTORY_TAB_KEY)
    .then((stored) => {
      const tabId = stored?.[INVENTORY_TAB_KEY];
      if (typeof tabId !== "number") return undefined;
      return browser.tabs
        .remove(tabId)
        .catch(() => undefined)
        .then(() => browser.storage.session.set({ [INVENTORY_TAB_KEY]: null }));
    })
    .catch(() => undefined);

  void loadResumablePlaylistJobs().then((jobs) => {
    for (const job of jobs) {
      // A service-worker restart can happen while the extension-owned window still exists. Close
      // it first, then restart only the interrupted item with a fresh, known worker.
      void closeWorker(job).then((cleaned) => {
        const resumed = resetInterruptedItem(cleaned);
        return savePlaylistJob(resumed).then(() => startJob(resumed.jobId));
      });
    }
  });
}
