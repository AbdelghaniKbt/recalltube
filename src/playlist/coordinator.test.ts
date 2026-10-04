import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaylistIndexJob, PlaylistInventory } from "../types/playlist";

/**
 * Worker-ownership regression tests.
 *
 * These cover four ways the coordinator was observed to lose, leak or duplicate its single worker:
 * a resume racing the previous run's cleanup, a resume that forgets a worker it never closed, a
 * closed owner tab poisoning worker creation, and a worker window/navigation ordering race.
 * Every one of those lives in the ordering of browser calls rather than in a pure
 * function, so the real module is driven against a fake `browser` and a fake job store.
 */

interface FakeTab {
  id: number;
  windowId: number;
  url?: string;
  active?: boolean;
  muted?: boolean;
}

const jobs = new Map<string, PlaylistIndexJob>();
const transcripts = new Map<string, unknown>();
let tabs: FakeTab[] = [];
let windows: Array<{ id: number; state?: string; focused?: boolean }> = [];
/** Id of the window that has OS focus; 1 is the user's browsing window. */
let focusedWindowId = 1;
/** Simulates a window manager that activates a restored window even when asked not to. */
let restoringActivatesWindow = false;
let nextId = 100;
/** Every tab id the coordinator created, so a test can assert none survived. */
let created: number[] = [];
/** The most worker tabs alive at once — the "one global worker" constraint, measured. */
let peakWorkers = 0;
let windowUpdates: Array<{ id: number; state?: string }> = [];
let snapshotReason = "no-captions";
/** The content script's "no other stage can help" flag, as the player's unavailability verdict sets it. */
let snapshotTerminal = false;
let nativeRequested = new Set<number>();
/** Stands in for chrome.storage.session, which Chrome clears on browser restart. */
let sessionStore = new Map<string, unknown>();

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tab(id: number): FakeTab | undefined {
  return tabs.find((candidate) => candidate.id === id);
}

function liveWorkers(): number {
  return tabs.filter((candidate) => created.includes(candidate.id)).length;
}

const browserMock = {
  runtime: {
    id: "recalltube-test",
    onMessage: { addListener: vi.fn() },
    sendMessage: vi.fn(async () => undefined),
  },
  tabs: {
    create: vi.fn(async (options: { openerTabId?: number; url?: string; active?: boolean }) => {
      // Chrome rejects an opener that no longer exists; that rejection is the behaviour under test.
      if (options.openerTabId !== undefined && !tab(options.openerTabId)) {
        throw new Error(`No tab with id: ${options.openerTabId}.`);
      }
      const record: FakeTab = { id: (nextId += 1), windowId: 1, url: options.url, active: options.active };
      tabs.push(record);
      created.push(record.id);
      peakWorkers = Math.max(peakWorkers, liveWorkers());
      return record;
    }),
    get: vi.fn(async (id: number) => {
      const found = tab(id);
      if (!found) throw new Error(`No tab with id: ${id}.`);
      return found;
    }),
    remove: vi.fn(async (id: number) => {
      // Chrome does not tear a tab down synchronously, and that latency is the whole cleanup
      // window a resume used to slip through.
      await settle(120);
      tabs = tabs.filter((candidate) => candidate.id !== id);
    }),
    update: vi.fn(async (id: number, changes: Partial<FakeTab>) => {
      const found = tab(id);
      if (!found) throw new Error(`No tab with id: ${id}.`);
      Object.assign(found, changes);
      return found;
    }),
    reload: vi.fn(async () => undefined),
    sendMessage: vi.fn(async (id: number, message: { type: string; acquisitionMode?: string }) => {
      if (!tab(id)) throw new Error("Receiving end does not exist.");
      if (message.type !== "recalltube:get-state") {
        if (message.type === "recalltube:refresh" && message.acquisitionMode === "native-panel") {
          nativeRequested.add(id);
          return { ok: true, generation: 2, documentId: `doc-${id}` };
        }
        return { ok: true };
      }
      const workerUrl = tab(id)?.url;
      return {
        ok: true,
        snapshot: {
          status: "failed",
          videoId: workerUrl ? new URL(workerUrl).searchParams.get("v") : undefined,
          generation: nativeRequested.has(id) ? 2 : 1,
          reason: snapshotReason,
          terminal: snapshotTerminal || undefined,
        },
      };
    }),
  },
  storage: {
    session: {
      get: vi.fn(async (key: string) => ({ [key]: sessionStore.get(key) })),
      set: vi.fn(async (values: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(values)) sessionStore.set(key, value);
      }),
    },
  },
  windows: {
    create: vi.fn(async (options: { tabId?: number; url?: string }) => {
      // Chrome ignores `state: "minimized"` here; the fake reproduces that faithfully.
      const record = { id: (nextId += 1), state: "normal", focused: false };
      windows.push(record);
      let host = options.tabId === undefined ? undefined : tab(options.tabId);
      if (!host && options.url) {
        host = { id: (nextId += 1), windowId: record.id, url: options.url, active: true };
        tabs.push(host);
        created.push(host.id);
        peakWorkers = Math.max(peakWorkers, liveWorkers());
      }
      if (host) host.windowId = record.id;
      return { ...record, tabs: host ? [host] : [] };
    }),
    update: vi.fn(async (id: number, changes: { state?: string; focused?: boolean }) => {
      const found = windows.find((candidate) => candidate.id === id);
      windowUpdates.push({ id, state: changes.state });
      if (found && changes.state) found.state = changes.state;
      if (changes.focused === true) focusedWindowId = id;
      if (found && changes.state === "normal" && restoringActivatesWindow) focusedWindowId = id;
      return found;
    }),
    getLastFocused: vi.fn(async () => ({ id: focusedWindowId, focused: true })),
    get: vi.fn(async (id: number) => {
      const found = windows.find((candidate) => candidate.id === id) ?? (id === 1 ? { id: 1 } : undefined);
      if (!found) throw new Error(`No window with id: ${id}.`);
      return { ...found, tabs: tabs.filter((candidate) => candidate.windowId === id) };
    }),
    remove: vi.fn(async (id: number) => {
      windows = windows.filter((candidate) => candidate.id !== id);
      tabs = tabs.filter((candidate) => candidate.windowId !== id);
    }),
  },
};

vi.mock("wxt/browser", () => ({ browser: browserMock }));

vi.mock("../storage/indexeddb", () => ({
  loadPlaylistJob: async (jobId: string) => jobs.get(jobId),
  savePlaylistJob: async (job: PlaylistIndexJob) => {
    jobs.set(job.jobId, job);
  },
  loadLatestPlaylistJob: async (playlistId: string) =>
    [...jobs.values()].filter((job) => job.playlistId === playlistId).sort((l, r) => r.updatedAt - l.updatedAt)[0],
  loadResumablePlaylistJobs: async () =>
    [...jobs.values()].filter((job) => job.state === "running" || job.state === "queued"),
  loadTranscriptForVideo: async (videoId: string) => transcripts.get(videoId),
  savePlaylistInventory: async () => undefined,
  saveTranscript: async () => undefined,
}));

const { handlePlaylistCommandForTest, isOwnedWorkerTab, setCoordinatorTimingForTest } = await import("./coordinator");

const inventory: PlaylistInventory = {
  playlistId: "PL1234567890abcdef",
  title: "Series",
  complete: true,
  sources: ["dom"],
  collectedAt: 1,
  items: [
    { videoId: "aaa12345678", title: "A", position: 0 },
    { videoId: "bbb12345678", title: "B", position: 1 },
  ],
};

beforeEach(() => {
  jobs.clear();
  transcripts.clear();
  tabs = [];
  windows = [];
  created = [];
  windowUpdates = [];
  peakWorkers = 0;
  nextId = 100;
  snapshotReason = "no-captions";
  snapshotTerminal = false;
  nativeRequested = new Set();
  sessionStore = new Map();
  focusedWindowId = 1;
  restoringActivatesWindow = false;
  setCoordinatorTimingForTest({ nativeStallMs: 45_000, nativeCapMs: 240_000, retryPassDelayMs: 5_000, hiddenBeforeFocusMs: 5_000 });
  vi.clearAllMocks();
  // `clearAllMocks` keeps implementations a previous test replaced (e.g. a rejecting session store).
  browserMock.storage.session.get.mockImplementation(async (key: string) => ({ [key]: sessionStore.get(key) }));
  browserMock.storage.session.set.mockImplementation(async (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) sessionStore.set(key, value);
  });
});

describe("playlist coordinator worker ownership", () => {
  it("keeps one worker and leaks none when a resume races the previous run's cleanup", async () => {
    tabs.push({ id: 7, windowId: 1 });
    const started = await handlePlaylistCommandForTest({
      type: "recalltube:playlist-start",
      inventory,
      ownerTabId: 7,
    });
    const jobId = started.job!.jobId;
    await settle(60);

    // Exactly the window in which the previous run's `finally` was still closing a worker the new
    // run had already replaced.
    await handlePlaylistCommandForTest({ type: "recalltube:playlist-pause", jobId });
    await handlePlaylistCommandForTest({ type: "recalltube:playlist-resume", jobId });
    await settle(120);
    await handlePlaylistCommandForTest({ type: "recalltube:playlist-cancel", jobId });
    await settle(400);

    expect(peakWorkers).toBeLessThanOrEqual(1);
    expect(created.filter((id) => tab(id) !== undefined)).toEqual([]);
    expect(jobs.get(jobId)?.workerTabId).toBeUndefined();
  });

  it("never resurrects a cancelled job or opens a worker for it", async () => {
    jobs.set("job-cancelled-1", {
      jobId: "job-cancelled-1",
      playlistId: inventory.playlistId,
      state: "cancelled",
      items: inventory.items.map((item) => ({ ...item, state: "pending" as const, attempts: 0, updatedAt: 1 })),
      createdAt: 1,
      updatedAt: 1,
    });

    // A run chained behind an earlier one starts after the user has had time to cancel.
    await handlePlaylistCommandForTest({ type: "recalltube:playlist-get", playlistId: inventory.playlistId });
    await handlePlaylistCommandForTest({ type: "recalltube:playlist-resume", jobId: "job-cancelled-1" });
    await handlePlaylistCommandForTest({ type: "recalltube:playlist-cancel", jobId: "job-cancelled-1" });
    await settle(400);

    expect(jobs.get("job-cancelled-1")?.state).toBe("cancelled");
    expect(created.filter((id) => tab(id) !== undefined)).toEqual([]);
  });

  it("never drives or closes a tab whose id it cannot vouch for in this browser session", async () => {
    // Tab ids are persisted in IndexedDB and Chrome restarts its id counter with the browser, so a
    // job restored after a browser restart can name a tab the *user* opened. Session-scoped
    // ownership is empty here, exactly as it is after a restart.
    const userTab: FakeTab = { id: 42, windowId: 1, url: "https://www.youtube.com/watch?v=someoneelse" };
    tabs.push(userTab);
    jobs.set("job-restored-1", {
      jobId: "job-restored-1",
      playlistId: inventory.playlistId,
      state: "queued",
      items: inventory.items.map((item) => ({ ...item, state: "pending" as const, attempts: 0, updatedAt: 1 })),
      createdAt: 1,
      updatedAt: 1,
      workerTabId: 42,
    });

    await handlePlaylistCommandForTest({ type: "recalltube:playlist-resume", jobId: "job-restored-1" });
    await settle(150);

    // The user's tab must be neither navigated nor closed; a fresh worker is created instead.
    expect(tab(42)).toBeDefined();
    expect(tab(42)!.url).toBe("https://www.youtube.com/watch?v=someoneelse");
    expect(created).not.toContain(42);
  });

  it("falls back to trusting the id when the session store cannot answer", async () => {
    // Treating an unavailable store as "not ours" would open a fresh tab per video and close none.
    browserMock.storage.session.get.mockRejectedValueOnce(new Error("session storage unavailable"));
    browserMock.storage.session.get.mockRejectedValue(new Error("session storage unavailable"));
    browserMock.storage.session.set.mockRejectedValue(new Error("session storage unavailable"));
    tabs.push({ id: 13, windowId: 1 });
    const started = await handlePlaylistCommandForTest({
      type: "recalltube:playlist-start",
      inventory,
      ownerTabId: 13,
    });
    await settle(2_600);

    expect(peakWorkers).toBeLessThanOrEqual(1);
    const job = jobs.get(started.job!.jobId)!;
    expect(job.items.map((item) => item.state)).toEqual(["no-captions", "no-captions"]);
    expect(created.filter((id) => tab(id) !== undefined)).toEqual([]);
  });

  it("closes a worker that survived a pause before resuming the job", async () => {
    // A service worker killed mid-cleanup leaves a paused job still owning a live tab, and
    // `loadResumablePlaylistJobs` never revisits a paused job.
    tabs.push({ id: 55, windowId: 1, url: "https://www.youtube.com/watch?v=aaa12345678" });
    // Same browser session, so session-scoped ownership still vouches for the id.
    sessionStore.set("recalltube:owned-workers", [55]);
    jobs.set("job-paused-01", {
      jobId: "job-paused-01",
      playlistId: inventory.playlistId,
      state: "paused",
      items: inventory.items.map((item) => ({ ...item, state: "pending" as const, attempts: 0, updatedAt: 1 })),
      createdAt: 1,
      updatedAt: 1,
      workerTabId: 55,
    });

    await handlePlaylistCommandForTest({ type: "recalltube:playlist-resume", jobId: "job-paused-01" });
    await settle(60);

    expect(tab(55)).toBeUndefined();
  });

  it("keeps acquiring after the owner tab is closed", async () => {
    tabs.push({ id: 9, windowId: 1 });
    const started = await handlePlaylistCommandForTest({
      type: "recalltube:playlist-start",
      inventory,
      ownerTabId: 9,
    });
    const jobId = started.job!.jobId;
    await settle(80);

    // The user closes their YouTube tab, and the worker tab goes with the queue's next navigation.
    tabs = tabs.filter((candidate) => candidate.id !== 9);
    for (const id of [...created]) tabs = tabs.filter((candidate) => candidate.id !== id);
    await settle(1_400);

    const job = jobs.get(jobId)!;
    // The queue must report what YouTube said, not a tab-creation failure.
    expect(job.items.map((item) => item.failureReason)).toEqual(["no-captions", "no-captions"]);
    expect(job.lastError).toBeUndefined();
  });

  it("keeps direct acquisition minimized, then requests the native panel explicitly", async () => {
    snapshotReason = "captions-withheld";
    tabs.push({ id: 11, windowId: 1 });
    await handlePlaylistCommandForTest({
      type: "recalltube:playlist-start",
      inventory,
      ownerTabId: 11,
    });
    await settle(200);

    expect(browserMock.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ focused: false, state: "minimized", type: "popup" })
    );
    expect(browserMock.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: "about:blank" })
    );
    expect(browserMock.tabs.update).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ url: "https://www.youtube.com/watch?v=aaa12345678" })
    );
    expect(browserMock.tabs.sendMessage).toHaveBeenCalledWith(
      expect.any(Number),
      { type: "recalltube:refresh", acquisitionMode: "native-panel" }
    );
  });

  it("renders the native stage without ever requesting focus, and leaves the user's focus alone", async () => {
    // Measured: a minimized worker never builds the transcript control; an unfocused normal window
    // captures every row. The old code focused the worker for every item, then focused the owner's
    // window after every item — 128 focus changes on a 10-video playlist.
    snapshotReason = "captions-withheld";
    tabs.push({ id: 21, windowId: 1 });
    await handlePlaylistCommandForTest({ type: "recalltube:playlist-start", inventory, ownerTabId: 21 });
    await settle(2_600);

    const focusRequests = browserMock.windows.update.mock.calls.filter(([, changes]) => (changes as { focused?: boolean }).focused === true);
    expect(focusRequests).toEqual([]);
    // Restored to a normal, small, unfocused window with explicit bounds — never focused.
    expect(browserMock.windows.update).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ focused: false, state: "normal", width: 720, height: 540 })
    );
    expect(focusedWindowId).toBe(1);
  });

  it("gives focus back to the window that had it if restoring the worker activated it anyway", async () => {
    snapshotReason = "captions-withheld";
    restoringActivatesWindow = true;
    tabs.push({ id: 22, windowId: 1 });
    const started = await handlePlaylistCommandForTest({ type: "recalltube:playlist-start", inventory, ownerTabId: 22 });
    await settle(2_600);

    expect(focusedWindowId).toBe(1);
    expect(jobs.get(started.job!.jobId)?.restoreFocusWindowId).toBeUndefined();
  });

  it("retries Chrome's transient tab-edit rejection instead of failing the item", async () => {
    // Live on 2026-09-16: "Tabs cannot be edited right now (user may be dragging a tab)." while the
    // worker window was being restored failed a playlist item as a network error.
    snapshotReason = "captions-withheld";
    tabs.push({ id: 23, windowId: 1 });
    const realUpdate = browserMock.tabs.update.getMockImplementation()!;
    let rejected = 0;
    browserMock.tabs.update.mockImplementation(async (id: number, changes: Partial<FakeTab>) => {
      if (changes.active === true && rejected < 2) {
        rejected += 1;
        throw new Error("Tabs cannot be edited right now (user may be dragging a tab).");
      }
      return realUpdate(id, changes);
    });
    const started = await handlePlaylistCommandForTest({ type: "recalltube:playlist-start", inventory, ownerTabId: 23 });
    await settle(3_200);
    browserMock.tabs.update.mockImplementation(realUpdate);

    const job = jobs.get(started.job!.jobId)!;
    expect(rejected).toBe(2);
    expect(job.lastError).toBeUndefined();
    expect(job.items[0]?.failureReason).toBe("captions-withheld");
    expect(nativeRequested.size).toBeGreaterThan(0);
  });

  it("re-issues the native request when restoring the worker replaced its document", async () => {
    // Live on 2026-09-16, 5 of 10 playlist items failed the same way: restoring the minimized worker
    // replaced its page, the native request went to the discarded document, the new document ran its
    // own direct-only attempt (generation 1 again), and the coordinator waited 55 s for generation 2.
    tabs.push({ id: 24, windowId: 1 });
    const realSend = browserMock.tabs.sendMessage.getMockImplementation()!;
    const documents = new Map<number, { id: string; generation: number; status: string; nativeRequests: number }>();
    let replaced = false;
    browserMock.tabs.sendMessage.mockImplementation((async (id: number, message: { type: string; acquisitionMode?: string }) => {
      if (!tab(id)) throw new Error("Receiving end does not exist.");
      let page = documents.get(id);
      if (!page) {
        page = { id: `doc-${id}-a`, generation: 1, status: "failed", nativeRequests: 0 };
        documents.set(id, page);
      }
      const videoId = new URL(tab(id)!.url!).searchParams.get("v");
      if (message.type === "recalltube:refresh" && message.acquisitionMode === "native-panel") {
        if (!replaced) {
          // The request lands in the page that is about to be replaced.
          replaced = true;
          documents.set(id, { id: `doc-${id}-b`, generation: 1, status: "failed", nativeRequests: 0 });
          return { ok: true, generation: page.generation + 1, documentId: page.id };
        }
        page.generation += 1;
        page.status = "ready";
        page.nativeRequests += 1;
        return { ok: true, generation: page.generation, documentId: page.id };
      }
      if (message.type === "recalltube:get-state") {
        const snapshot = page.status === "ready"
          ? {
              status: "ready",
              videoId,
              generation: page.generation,
              document: {
                transcriptId: `t-${videoId}`,
                video: { id: videoId, title: "t", url: "u" },
                cues: [{ start: 0, end: 1, text: "x" }],
                source: "dom",
                fetchedAt: 1,
                parserVersion: 1,
              },
            }
          : { status: "failed", videoId, generation: page.generation, reason: "captions-withheld" };
        return { ok: true, snapshot, documentId: page.id };
      }
      return realSend(id, message);
    }) as never);

    const started = await handlePlaylistCommandForTest({
      type: "recalltube:playlist-start",
      inventory: { ...inventory, items: [inventory.items[0]!] },
      ownerTabId: 24,
    });
    await settle(4_000);
    browserMock.tabs.sendMessage.mockImplementation(realSend);

    const job = jobs.get(started.job!.jobId)!;
    expect(job.items[0]?.state).toBe("indexed");
  }, 20_000);

  /**
   * A scripted worker page. `plan(attempt)` decides how the n-th native attempt behaves: how long it
   * stays loading, whether it reports progress while it does, and whether it ends ready.
   */
  function scriptWorker(plan: (nativeAttempt: number) => { loadingMs: number; progress: boolean; ready: boolean; hidden?: boolean }) {
    const realSend = browserMock.tabs.sendMessage.getMockImplementation()!;
    let nativeAttempts = 0;
    const pages = new Map<number, { generation: number; startedAt: number; attempt: number }>();
    browserMock.tabs.sendMessage.mockImplementation((async (id: number, message: { type: string; acquisitionMode?: string }) => {
      if (!tab(id)) throw new Error("Receiving end does not exist.");
      const videoId = new URL(tab(id)!.url!).searchParams.get("v");
      if (message.type === "recalltube:refresh" && message.acquisitionMode === "native-panel") {
        nativeAttempts += 1;
        pages.set(id, { generation: 2, startedAt: Date.now(), attempt: nativeAttempts });
        return { ok: true, generation: 2, documentId: `doc-${id}` };
      }
      if (message.type !== "recalltube:get-state") return realSend(id, message);
      const page = pages.get(id);
      if (!page) return { ok: true, documentId: `doc-${id}`, snapshot: { status: "failed", videoId, generation: 1, reason: "captions-withheld" } };
      const step = plan(page.attempt);
      const elapsed = Date.now() - page.startedAt;
      if (elapsed < step.loadingMs) {
        // A stalled page reports nothing new: the real content script changes `at` only when the
        // capture reports progress, so a non-progressing fake must keep it fixed too.
        const progress = step.hidden
          ? { phase: "native-rows", rows: 0, hidden: true, at: Date.now() }
          : step.progress
            ? { phase: "native-settle", rows: Math.floor(elapsed / 100), at: Date.now() }
            : { phase: "native-rows", rows: 0, at: page.startedAt };
        return { ok: true, documentId: `doc-${id}`, snapshot: { status: "loading", videoId, generation: 2, progress } };
      }
      const snapshot = step.ready
        ? { status: "ready", videoId, generation: 2, document: { transcriptId: `t-${videoId}`, video: { id: videoId, title: "t", url: "u" }, cues: [{ start: 0, end: 1, text: "x" }], source: "dom", fetchedAt: 1, parserVersion: 1 } }
        : { status: "failed", videoId, generation: 2, reason: "not-ready" };
      return { ok: true, documentId: `doc-${id}`, snapshot };
    }) as never);
    return () => browserMock.tabs.sendMessage.mockImplementation(realSend);
  }

  const oneItem = { ...inventory, items: [inventory.items[0]!] };

  it("recovers a transient failure on its own, without the user clicking Retry failures", async () => {
    setCoordinatorTimingForTest({ nativeStallMs: 1_000, nativeCapMs: 5_000, retryPassDelayMs: 50 });
    tabs.push({ id: 41, windowId: 1 });
    const restore = scriptWorker((attempt) => ({ loadingMs: 100, progress: false, ready: attempt >= 2 }));
    const started = await handlePlaylistCommandForTest({ type: "recalltube:playlist-start", inventory: oneItem, ownerTabId: 41 });
    await settle(6_000);
    restore();
    const job = jobs.get(started.job!.jobId)!;
    expect(job.state).toBe("completed");
    expect(job.items[0]).toMatchObject({ state: "indexed", attempts: 2 });
  }, 20_000);

  it("keeps waiting for a native capture that is slow but still advancing", async () => {
    // The stall limit must exceed the coordinator's 500 ms poll, as the real 45 s limit does.
    setCoordinatorTimingForTest({ nativeStallMs: 1_200, nativeCapMs: 20_000, retryPassDelayMs: 50 });
    tabs.push({ id: 42, windowId: 1 });
    // 5 s of loading is four stall limits long, but rows keep increasing throughout.
    const restore = scriptWorker(() => ({ loadingMs: 5_000, progress: true, ready: true }));
    const started = await handlePlaylistCommandForTest({ type: "recalltube:playlist-start", inventory: oneItem, ownerTabId: 42 });
    await settle(8_000);
    restore();
    expect(jobs.get(started.job!.jobId)!.items[0]).toMatchObject({ state: "indexed", attempts: 1 });
  }, 20_000);

  it("gives up on a native capture that has stopped advancing, after the stall limit and not the cap", async () => {
    setCoordinatorTimingForTest({ nativeStallMs: 1_200, nativeCapMs: 60_000, retryPassDelayMs: 60_000 });
    tabs.push({ id: 43, windowId: 1 });
    const restore = scriptWorker(() => ({ loadingMs: 60_000, progress: false, ready: false }));
    const started = await handlePlaylistCommandForTest({ type: "recalltube:playlist-start", inventory: oneItem, ownerTabId: 43 });
    await settle(4_500);
    restore();
    const item = jobs.get(started.job!.jobId)!.items[0]!;
    // Failed once at the stall limit (well before the 60 s cap) and already queued for its retry pass.
    expect(item.attempts).toBe(1);
    expect(item.failureReason).toBe("captions-withheld");
    expect(item.state).toBe("pending");
    await handlePlaylistCommandForTest({ type: "recalltube:playlist-cancel", jobId: started.job!.jobId });
    await settle(500);
  }, 20_000);

  it("never turns a video with an advertised caption track into a terminal no-captions failure", async () => {
    // Live at 4x CPU, the native stage found no transcript control within 15 s on a slow page and
    // reported "no-captions" for two videos that have captions; that state is never retried.
    const { combinedFailureReason } = await import("./coordinator");
    expect(combinedFailureReason("captions-withheld", "no-captions")).toBe("captions-withheld");
    expect(combinedFailureReason("captions-withheld", "not-ready")).toBe("captions-withheld");
    expect(combinedFailureReason("captions-withheld", undefined)).toBe("captions-withheld");
    // With no advertised track, the native stage's "no captions" is the honest answer.
    expect(combinedFailureReason("no-captions", "no-captions")).toBe("no-captions");
    expect(combinedFailureReason(undefined, "permission-denied")).toBe("permission-denied");
  });

  it("never closes a recorded window that holds a tab the extension does not own", async () => {
    // Window 1 is the user’s browsing window. A job whose recorded worker window id points at it
    // (stale or corrupted) may close its own worker tab, but never the window.
    tabs.push({ id: 51, windowId: 1, url: "https://www.youtube.com/watch?v=user0000001" });
    tabs.push({ id: 52, windowId: 1, url: "https://www.youtube.com/watch?v=aaa12345678" });
    sessionStore.set("recalltube:owned-workers", [52]);
    jobs.set("job-bad-window", {
      jobId: "job-bad-window",
      playlistId: inventory.playlistId,
      state: "paused",
      items: inventory.items.map((item) => ({ ...item, state: "pending" as const, attempts: 0, updatedAt: 1 })),
      createdAt: 1,
      updatedAt: 1,
      workerTabId: 52,
      workerWindowId: 1,
    });
    await handlePlaylistCommandForTest({ type: "recalltube:playlist-cancel", jobId: "job-bad-window" });
    await handlePlaylistCommandForTest({ type: "recalltube:playlist-retry", jobId: "job-bad-window" });
    await settle(600);
    await handlePlaylistCommandForTest({ type: "recalltube:playlist-cancel", jobId: "job-bad-window" });
    await settle(400);

    expect(browserMock.windows.remove).not.toHaveBeenCalledWith(1);
    expect(tab(51)).toBeDefined();
    expect(tab(52)).toBeUndefined();
  });

  it("brings a worker to the front only after its page reports itself hidden, then gives focus back", async () => {
    setCoordinatorTimingForTest({ nativeStallMs: 10_000, nativeCapMs: 20_000, retryPassDelayMs: 60_000, hiddenBeforeFocusMs: 600 });
    tabs.push({ id: 44, windowId: 1 });
    const restore = scriptWorker(() => ({ loadingMs: 2_000, progress: false, ready: true, hidden: true }));
    const started = await handlePlaylistCommandForTest({ type: "recalltube:playlist-start", inventory: oneItem, ownerTabId: 44 });
    await settle(5_000);
    restore();

    const job = jobs.get(started.job!.jobId)!;
    expect(job.items[0]?.state).toBe("indexed");
    const focusRequests = browserMock.windows.update.mock.calls.filter(([, changes]) => (changes as { focused?: boolean }).focused === true);
    // Once for the hidden worker, once to give focus back to the user’s window.
    expect(focusRequests.map(([id]) => id === 1)).toEqual([false, true]);
    expect(focusedWindowId).toBe(1);
  }, 20_000);

  it("recognizes only session-owned worker tabs as playlist workers", async () => {
    sessionStore.set("recalltube:owned-workers", [31]);
    expect(await isOwnedWorkerTab(31)).toBe(true);
    expect(await isOwnedWorkerTab(32)).toBe(false);
    expect(await isOwnedWorkerTab(undefined)).toBe(false);
  });

  it("never shows the worker for a video the player reports as unavailable", async () => {
    // A removed or private playlist item has no transcript control to render. Restoring the worker
    // window for it put a useless YouTube error page on the user's screen for the whole native wait.
    snapshotReason = "video-unavailable";
    snapshotTerminal = true;
    tabs.push({ id: 61, windowId: 1 });
    const started = await handlePlaylistCommandForTest({ type: "recalltube:playlist-start", inventory, ownerTabId: 61 });
    await settle(2_600);

    const job = jobs.get(started.job!.jobId)!;
    expect(job.items.map((item) => item.state)).toEqual(["unavailable", "unavailable"]);
    expect(nativeRequested.size).toBe(0);
    expect(windowUpdates.filter((update) => update.state === "normal")).toEqual([]);
    expect(created.filter((id) => tab(id) !== undefined)).toEqual([]);
  });

  it("places the rendering worker in a corner of the window that had focus", async () => {
    const { workerBoundsNear } = await import("./coordinator");
    expect(workerBoundsNear({ left: 100, top: 50, width: 1600, height: 900 })).toEqual({
      width: 720,
      height: 540,
      left: 100 + 1600 - 720 - 24,
      top: 50 + 900 - 540 - 24,
    });
    // Unknown reference bounds: size only, and Chrome places the window.
    expect(workerBoundsNear(undefined)).toEqual({ width: 720, height: 540 });
    // Never off-screen to the left or top.
    expect(workerBoundsNear({ left: 0, top: 0, width: 500, height: 400 })).toEqual({ width: 720, height: 540, left: 0, top: 0 });
  });
});
