import { browser } from "wxt/browser";
import {
  acquireTranscript,
  currentVideoId,
  describeTranscriptDom,
  NativePanelTranscriptAdapter,
  PlayerTrackAdapter,
  RenderedTranscriptAdapter,
  transcriptPanelState,
  transcriptRowsRendered,
  requestPageData,
} from "../transcript/acquire";
import { mergePlaylistInventories } from "../playlist/inventory";
import type { PlaylistInventory } from "../types/playlist";
import { parseContentRequest } from "../types/messages";
import type { ContentResponse } from "../types/messages";
import type { AdapterDiagnostic, PageSnapshot } from "../types/transcript";

type AcquisitionMode = "automatic" | "direct-only" | "native-panel";
const DIRECT_ONLY_ADAPTERS = [new PlayerTrackAdapter()];
const NATIVE_PANEL_ADAPTERS = [new NativePanelTranscriptAdapter(), new RenderedTranscriptAdapter()];

export default defineContentScript({
  matches: ["*://*.youtube.com/*"],
  runAt: "document_idle",
  main() {
    let snapshot: PageSnapshot = { status: "idle", generation: 0 };
    /** This page instance; a replaced document restarts generations and must be recognizable. */
    const documentId = crypto.randomUUID();
    let generation = 0;
    let inFlight: AbortController | undefined;
    /** Mode of the attempt in flight, once resolved. */
    let inFlightMode: AcquisitionMode | undefined;
    let lastUrl = location.href;
    let preferredLanguage: string | undefined;
    let diagnostics: AdapterDiagnostic[] = [];
    let panelObserver: MutationObserver | undefined;
    let panelCheckTimer: number | undefined;

    const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

    const inventoryScrollTarget = (): HTMLElement | null => {
      const candidates = [
        document.querySelector<HTMLElement>("ytd-playlist-panel-renderer #items"),
        document.querySelector<HTMLElement>("ytd-playlist-video-list-renderer #contents"),
        document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null,
      ];
      return candidates.find((element) => element && element.scrollHeight > element.clientHeight) ?? candidates.at(-1) ?? null;
    };

    /** Collects lazy playlist rows through the rendered page, without calling an internal API. */
    const collectPlaylist = async (complete: boolean): Promise<PlaylistInventory | undefined> => {
      const controller = new AbortController();
      let inventory: PlaylistInventory | undefined;
      let stableRounds = 0;
      let previousCount = -1;
      const rounds = complete ? 80 : 1;
      try {
        for (let round = 0; round < rounds; round += 1) {
          const page = await requestPageData(controller.signal, 3_000);
          inventory = mergePlaylistInventories(inventory, page.playlist);
          if (!complete || inventory?.complete) break;
          if ((inventory?.items.length ?? 0) === previousCount) stableRounds += 1;
          else stableRounds = 0;
          if (stableRounds >= 4) break;
          previousCount = inventory?.items.length ?? 0;
          const target = inventoryScrollTarget();
          if (!target) break;
          target.scrollTo({ top: target.scrollHeight, behavior: "instant" });
          target.dispatchEvent(new Event("scroll", { bubbles: true }));
          await wait(450);
        }
      } finally {
        controller.abort();
      }
      return inventory;
    };

    /** How long the observer stays attached after a failed attempt or after a user gesture. */
    const PANEL_WATCH_MS = 60_000;
    let panelWatchDeadline: number | undefined;

    const stopWatchingForTranscriptPanel = () => {
      panelObserver?.disconnect();
      panelObserver = undefined;
      if (panelCheckTimer !== undefined) window.clearTimeout(panelCheckTimer);
      panelCheckTimer = undefined;
      if (panelWatchDeadline !== undefined) window.clearTimeout(panelWatchDeadline);
      panelWatchDeadline = undefined;
    };

    /**
     * Picks the transcript up if the user opens YouTube's panel after an attempt has failed.
     *
     * The automatic native-panel adapter owns the normal fallback and does its own bounded waiting;
     * this observer exists only for a panel the *user* opens later. It therefore runs only while the
     * page is in a failed state, for a bounded window, and is re-armed by a trusted user gesture —
     * the only thing that can open the panel once that window has lapsed. Before this bound, a video
     * without captions kept a whole-document observer attached for the life of the tab and walked
     * every shadow root 2.5 times a second during playback.
     *
     * The check is a row query, never a parse, and a trusted-gesture guard keeps the adapter's own
     * synthetic clicks from re-arming the observer during a capture it would then cancel.
     */
    const watchForTranscriptPanel = () => {
      stopWatchingForTranscriptPanel();
      if (snapshot.status !== "failed") return;

      panelObserver = new MutationObserver(() => {
        if (panelCheckTimer !== undefined) return;
        panelCheckTimer = window.setTimeout(() => {
          panelCheckTimer = undefined;
          if (snapshot.status !== "failed") {
            stopWatchingForTranscriptPanel();
            return;
          }
          if (transcriptRowsRendered()) {
            stopWatchingForTranscriptPanel();
            void load(undefined, undefined, "panel-observer");
          }
        }, 400);
      });
      panelObserver.observe(document.body, { childList: true, subtree: true });
      panelWatchDeadline = window.setTimeout(stopWatchingForTranscriptPanel, PANEL_WATCH_MS);
    };

    const rearmPanelWatchOnGesture = (event: Event) => {
      if (!event.isTrusted || panelObserver || snapshot.status !== "failed") return;
      watchForTranscriptPanel();
    };
    document.addEventListener("click", rearmPanelWatchOnGesture, { capture: true, passive: true });
    document.addEventListener("keyup", rearmPanelWatchOnGesture, { capture: true, passive: true });

    /**
     * A playlist worker needs YouTube's page, not its playback: a muted video still streams and
     * decodes several megabytes per item. Only an extension-owned worker is ever paused — the role
     * comes from session-scoped ownership — and the pause is bounded because YouTube may resume once.
     */
    let workerPlaybackPaused = false;
    const pauseWorkerPlayback = () => {
      if (workerPlaybackPaused) return;
      workerPlaybackPaused = true;
      let pauses = 0;
      const pause = () => {
        const video = document.querySelector<HTMLVideoElement>("video.html5-main-video, video");
        if (!video || video.paused || pauses >= 5) return;
        pauses += 1;
        video.pause();
      };
      pause();
      const onPlaying = () => pause();
      document.addEventListener("playing", onPlaying, { capture: true, passive: true });
      window.setTimeout(() => document.removeEventListener("playing", onPlaying, { capture: true }), 60_000);
    };

    const publish = () => {
      // No side panel listening is normal, not an error.
      void browser.runtime.sendMessage({ type: "recalltube:state-changed", snapshot, documentId }).catch(() => undefined);
    };

    /**
     * Whether this tab is a playlist worker the extension created, answered by the background from
     * session-scoped ownership. Asked once per document.
     *
     * The first stage of a playlist item is direct captions only, because a minimized worker cannot
     * render YouTube's transcript UI. That decision used to come from a `#recalltube-playlist-worker`
     * URL fragment, which any shared link could carry and which then silently disabled the native
     * fallback in an ordinary user tab. An unanswered question means an ordinary tab.
     */
    let workerRole: Promise<boolean> | undefined;
    const isPlaylistWorker = (): Promise<boolean> => {
      workerRole ??= Promise.race([
        (browser.runtime.sendMessage({ type: "recalltube:worker-role" }) as Promise<{ worker?: unknown } | undefined>)
          .then((response) => response?.worker === true)
          .catch(() => false),
        new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 2_000)),
      ]);
      return workerRole;
    };

    /**
     * YouTube's SPA navigation runs `yt-navigate-start` → `yt-player-updated` → `yt-navigate-finish`
     * → `yt-page-data-updated`, and about half a second after that last event it hides every
     * engagement panel. Measured live on 2026-10-03, `yt-page-data-updated` arrived 0.3–1.4 s after
     * `yt-navigate-finish`; a native capture that had already opened the transcript panel lost it,
     * saw no rows, and YouTube never fetched the transcript. Acquisition after a navigation therefore
     * waits for that event plus a settle period, bounded in case YouTube does not announce it.
     */
    const NAVIGATION_SETTLE_MS = 1_000;
    const PAGE_DATA_GRACE_MS = 2_500;
    let navigationStartedAt = 0;
    let pageDataUpdatedAt = 0;
    window.addEventListener("yt-navigate-start", () => {
      navigationStartedAt = performance.now();
    });
    window.addEventListener("yt-page-data-updated", () => {
      pageDataUpdatedAt = performance.now();
    });
    const navigationSettled = (signal: AbortSignal): Promise<void> =>
      new Promise((resolve) => {
        let settleTimer: number | undefined;
        let graceTimer: number | undefined;
        const cleanup = () => {
          window.removeEventListener("yt-page-data-updated", onPageData);
          signal.removeEventListener("abort", finish);
          if (settleTimer !== undefined) window.clearTimeout(settleTimer);
          if (graceTimer !== undefined) window.clearTimeout(graceTimer);
        };
        function finish() {
          cleanup();
          resolve();
        }
        function onPageData() {
          if (graceTimer !== undefined) window.clearTimeout(graceTimer);
          graceTimer = undefined;
          settleTimer ??= window.setTimeout(finish, NAVIGATION_SETTLE_MS);
        }
        signal.addEventListener("abort", finish, { once: true });
        if (navigationStartedAt > 0 && pageDataUpdatedAt >= navigationStartedAt) {
          // Page data for this navigation is already in; only the settle period remains.
          settleTimer = window.setTimeout(finish, Math.max(0, NAVIGATION_SETTLE_MS - (performance.now() - pageDataUpdatedAt)));
          return;
        }
        window.addEventListener("yt-page-data-updated", onPageData);
        graceTimer = window.setTimeout(finish, PAGE_DATA_GRACE_MS);
      });

    type LoadTrigger = "initial" | "navigation" | "panel-observer" | "refresh";
    const load = async (languageCode?: string, requestedMode?: AcquisitionMode, trigger: LoadTrigger = "initial") => {
      // Cancel the previous attempt rather than merely ignoring its result: the alpha let two or
      // three acquisitions race on rapid navigation.
      inFlight?.abort();
      stopWatchingForTranscriptPanel();
      const controller = new AbortController();
      inFlight = controller;

      const thisGeneration = ++generation;
      if (languageCode) preferredLanguage = languageCode;
      const videoId = currentVideoId();

      if (!videoId) {
        snapshot = { status: "idle", generation: thisGeneration };
        publish();
        return;
      }

      snapshot = { status: "loading", videoId, generation: thisGeneration };
      publish();

      inFlightMode = undefined;
      const acquisitionMode: AcquisitionMode =
        requestedMode ?? ((await isPlaylistWorker()) ? "direct-only" : "automatic");
      if (thisGeneration !== generation) return;
      if (trigger === "navigation") {
        await navigationSettled(controller.signal);
        if (thisGeneration !== generation || controller.signal.aborted) return;
      }
      inFlightMode = acquisitionMode;
      if (acquisitionMode === "direct-only") pauseWorkerPlayback();

      const result = await acquireTranscript(
        {
          videoId,
          preferredLanguage,
          generation: thisGeneration,
          // Not broadcast: callers poll `get-state`, and a long capture would otherwise flood them.
          onProgress: (phase, rows, hidden) => {
            if (thisGeneration !== generation || snapshot.status !== "loading") return;
            // `at` changes on every report, so a repeated report is a heartbeat, not a duplicate.
            snapshot = { ...snapshot, progress: { phase, rows, hidden: hidden || undefined, at: Date.now() } };
          },
        },
        controller.signal,
        acquisitionMode === "direct-only"
          ? DIRECT_ONLY_ADAPTERS
          : acquisitionMode === "native-panel"
            ? NATIVE_PANEL_ADAPTERS
            : undefined
      ).catch((): undefined => undefined);

      // A newer navigation has taken over; drop this result silently.
      if (thisGeneration !== generation) return;
      // Privacy-safe provenance: what started this attempt and in which mode. Without it, a failed
      // playlist item could not show whether the native stage ever ran.
      diagnostics = [
        {
          adapter: "content-script",
          outcome: "skipped" as const,
          detail: `attempt ${thisGeneration} started by ${trigger} in ${acquisitionMode} mode`,
          elapsedMs: 0,
        },
        ...(result?.diagnostics ?? []),
      ];

      if (!result) {
        snapshot = { status: "failed", videoId, generation: thisGeneration, reason: "network-error", diagnostics };
      } else if (result.ok) {
        snapshot = {
          status: "ready",
          videoId: result.transcript.video.id,
          generation: thisGeneration,
          document: result.transcript,
          diagnostics,
        };
      } else if (result.reason === "navigation-cancelled") {
        return;
      } else {
        snapshot = {
          status: "failed",
          videoId,
          generation: thisGeneration,
          reason: result.reason,
          terminal: result.terminal || undefined,
          diagnostics,
          // Structural state is retained for diagnostics and subsequent automatic retry decisions.
          transcriptPanel: transcriptPanelState(),
        };
      }
      // A user may still open YouTube's panel after a failure. A playlist worker has no user, and its
      // native stage is driven explicitly by the coordinator, so it never watches.
      if (snapshot.status === "failed" && acquisitionMode !== "direct-only") watchForTranscriptPanel();
      publish();
    };

    const onNavigation = () => {
      if (location.href === lastUrl) return;
      const previousVideo = currentVideoId(lastUrl);
      lastUrl = location.href;
      // YouTube rewrites the URL of the *same* video (tracking and timestamp parameters, history
      // normalization). Restarting acquisition for that aborted whatever was in flight: live, a
      // playlist worker's native-panel capture was cancelled and replaced by a second direct-only
      // attempt, and the item failed. Only a different video is a new transcript.
      if (currentVideoId() === previousVideo) return;
      // Language preference belongs to a video, not to the whole session.
      preferredLanguage = undefined;
      void load(undefined, undefined, "navigation");
    };

    browser.runtime.onMessage.addListener(
      (rawMessage: unknown, sender: chrome.runtime.MessageSender, sendResponse): boolean => {
        // Only our own extension surfaces may drive this content script.
        if (sender.id && sender.id !== browser.runtime.id) return false;
        const message = parseContentRequest(rawMessage);
        if (!message) return false;

        switch (message.type) {
          case "recalltube:get-state":
            sendResponse({ ok: true, snapshot, documentId });
            return false;
          case "recalltube:diagnostics":
            // Structure only — element names, class fragments and counts, never caption text.
            sendResponse({
              ok: true,
              snapshot,
              diagnostics: [
                ...diagnostics,
                {
                  adapter: "dom-probe",
                  outcome: "skipped" as const,
                  detail: describeTranscriptDom(),
                  elapsedMs: 0,
                },
                {
                  adapter: "panel-watch",
                  outcome: "skipped" as const,
                  detail: panelObserver ? "armed (bounded, re-armed by a user gesture)" : "idle",
                  elapsedMs: 0,
                },
              ],
            });
            return false;
          case "recalltube:get-playlist":
            void collectPlaylist(message.complete)
              .then((playlist) => sendResponse({ ok: true, playlist }))
              .catch((error: unknown) =>
                sendResponse({ ok: false, error: error instanceof Error ? error.message : "Playlist inventory failed." })
              );
            return true;
          case "recalltube:prepare-native":
            // A tab move can complete before YouTube rebuilds the rendered watch-page controls.
            // Do not start the native adapter against that transient, structurally empty document.
            void (async () => {
              for (let attempt = 0; attempt < 60; attempt += 1) {
                const panelState = transcriptPanelState();
                // A focused worker can report `complete` while YouTube is still replacing its
                // metadata-only background shell. Give that transition a bounded settling window;
                // a native attempt against the first complete frame is the race this handshake
                // exists to prevent.
                if (panelState !== "unavailable" || (document.readyState === "complete" && attempt >= 5)) {
                  sendResponse({
                    ok: true,
                    nativeReady: panelState !== "unavailable",
                    videoId: currentVideoId(),
                  });
                  return;
                }
                await wait(200);
              }
              sendResponse({ ok: true, nativeReady: false, videoId: currentVideoId() });
            })();
            return true;
          case "recalltube:refresh":
            // Coalesce an identical refresh into the acquisition already in flight. Aborting a
            // native-panel capture after it has opened the UI would close it and immediately open
            // it again from the replacement load. A language change is materially different and
            // still supersedes the current request.
            //
            // An explicit mode is also materially different. A native-panel request coalesced into
            // an in-flight direct-only attempt was silently dropped, which is how a playlist item
            // never reached its native stage.
            if (
              snapshot.status === "loading" &&
              (!message.languageCode || message.languageCode === preferredLanguage) &&
              (message.acquisitionMode === "automatic" || message.acquisitionMode === inFlightMode)
            ) {
              sendResponse({ ok: true, snapshot, generation, documentId });
              return false;
            }
            // "automatic" from an ordinary refresh still honours this tab's worker role.
            void load(
              message.languageCode,
              message.acquisitionMode === "automatic" ? undefined : message.acquisitionMode,
              "refresh"
            );
            // `load` claims its generation synchronously, so this is the attempt just started. A
            // caller waiting for *its* attempt must not accept an older or unrelated snapshot.
            sendResponse({ ok: true, snapshot, generation, documentId });
            return false;
          case "recalltube:seek": {
            const video = document.querySelector<HTMLVideoElement>("video.html5-main-video, video");
            if (!video) {
              sendResponse({ ok: false, error: "The YouTube player was not found." });
              return false;
            }
            video.currentTime = Math.max(0, message.seconds);
            void video.play().catch(() => undefined);
            sendResponse({ ok: true });
            return false;
          }
        }
      }
    );

    // YouTube's SPA navigation. The alpha also ran a MutationObserver over the whole document with
    // subtree: true, which fires thousands of times per second during playback purely to compare
    // one string. `yt-navigate-finish` plus history patching covers the
    // same navigations without that cost.
    //
    // A history navigation (Back/Forward) is announced by `popstate` first and finished by
    // `yt-navigate-finish` about a second later. Acting on `popstate` started acquisition in the
    // middle of the transition: live, the native stage opened the transcript panel before the finish
    // event, whose handler hides every engagement panel, and the capture ended with no rows while
    // YouTube never fetched the transcript. A history change therefore waits for the finish event,
    // with a bounded fallback for one YouTube does not announce.
    const HISTORY_NAVIGATION_GRACE_MS = 3_000;
    let historyNavigationTimer: number | undefined;
    const onHistoryNavigation = () => {
      if (historyNavigationTimer !== undefined) window.clearTimeout(historyNavigationTimer);
      historyNavigationTimer = window.setTimeout(() => {
        historyNavigationTimer = undefined;
        onNavigation();
      }, HISTORY_NAVIGATION_GRACE_MS);
    };
    window.addEventListener("yt-navigate-finish", () => {
      if (historyNavigationTimer !== undefined) window.clearTimeout(historyNavigationTimer);
      historyNavigationTimer = undefined;
      onNavigation();
    });
    window.addEventListener("popstate", onHistoryNavigation);

    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method];
      history[method] = function patched(this: History, ...args: Parameters<History["pushState"]>) {
        const result = original.apply(this, args);
        onHistoryNavigation();
        return result;
      } as History[typeof method];
    }

    void load();
  },
});
