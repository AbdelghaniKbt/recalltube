import { browser } from "wxt/browser";
import {
  acquireTranscript,
  currentVideoId,
  describeTranscriptDom,
  transcriptPanelState,
} from "../transcript/acquire";
import { parseContentRequest } from "../types/messages";
import type { ContentResponse } from "../types/messages";
import type { AdapterDiagnostic, PageSnapshot } from "../types/transcript";

export default defineContentScript({
  matches: ["*://*.youtube.com/*"],
  runAt: "document_idle",
  main() {
    let snapshot: PageSnapshot = { status: "idle", generation: 0 };
    let generation = 0;
    let inFlight: AbortController | undefined;
    let lastUrl = location.href;
    let preferredLanguage: string | undefined;
    let diagnostics: AdapterDiagnostic[] = [];
    let panelObserver: MutationObserver | undefined;
    let panelCheckTimer: number | undefined;

    const stopWatchingForTranscriptPanel = () => {
      panelObserver?.disconnect();
      panelObserver = undefined;
      if (panelCheckTimer !== undefined) window.clearTimeout(panelCheckTimer);
      panelCheckTimer = undefined;
    };

    /**
     * Picks the transcript up the moment YouTube renders it.
     *
     * The automatic native-panel adapter owns the normal fallback. This observer covers rows that
     * YouTube renders later (or that the user opens after an initial failure) without requiring a
     * precisely timed retry.
     *
     * The observer only runs while there is no transcript and disconnects the moment there is one,
     * which keeps it off the hot path during playback — a permanently-attached document observer
     * was a measured problem in the alpha. Checks are throttled, and
     * `transcriptPanelState` is scoped to transcript panels, so it is cheap while they are empty.
    */
    const watchForTranscriptPanel = () => {
      stopWatchingForTranscriptPanel();
      if (snapshot.status === "ready") return;

      panelObserver = new MutationObserver(() => {
        if (panelCheckTimer !== undefined) return;
        panelCheckTimer = window.setTimeout(() => {
          panelCheckTimer = undefined;
          if (snapshot.status === "ready") {
            stopWatchingForTranscriptPanel();
            return;
          }
          if (transcriptPanelState() === "open") {
            stopWatchingForTranscriptPanel();
            void load();
          }
        }, 400);
      });
      panelObserver.observe(document.body, { childList: true, subtree: true });
    };

    const publish = () => {
      // No side panel listening is normal, not an error.
      void browser.runtime.sendMessage({ type: "recalltube:state-changed", snapshot }).catch(() => undefined);
    };

    const load = async (languageCode?: string) => {
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

      const result = await acquireTranscript(
        { videoId, preferredLanguage, generation: thisGeneration },
        controller.signal
      ).catch((): undefined => undefined);

      // A newer navigation has taken over; drop this result silently.
      if (thisGeneration !== generation) return;
      diagnostics = result?.diagnostics ?? [];

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
          diagnostics,
          // Structural state is retained for diagnostics and subsequent automatic retry decisions.
          transcriptPanel: transcriptPanelState(),
        };
      }
      // Keep watching until a transcript exists, including rows YouTube renders after our attempt.
      if (snapshot.status !== "ready") watchForTranscriptPanel();
      publish();
    };

    const onNavigation = () => {
      if (location.href === lastUrl) return;
      const previousVideo = currentVideoId(lastUrl);
      lastUrl = location.href;
      // Language preference belongs to a video, not to the whole session.
      if (currentVideoId() !== previousVideo) preferredLanguage = undefined;
      void load();
    };

    browser.runtime.onMessage.addListener(
      (rawMessage: unknown, sender: chrome.runtime.MessageSender, sendResponse): boolean => {
        // Only our own extension surfaces may drive this content script.
        if (sender.id && sender.id !== browser.runtime.id) return false;
        const message = parseContentRequest(rawMessage);
        if (!message) return false;

        switch (message.type) {
          case "recalltube:get-state":
            sendResponse({ ok: true, snapshot });
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
              ],
            });
            return false;
          case "recalltube:refresh":
            // Coalesce an identical refresh into the acquisition already in flight. Aborting a
            // native-panel capture after it has opened the UI would close it and immediately open
            // it again from the replacement load. A language change is materially different and
            // still supersedes the current request.
            if (
              snapshot.status === "loading" &&
              (!message.languageCode || message.languageCode === preferredLanguage)
            ) {
              sendResponse({ ok: true, snapshot });
              return false;
            }
            void load(message.languageCode);
            sendResponse({ ok: true, snapshot });
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
    window.addEventListener("yt-navigate-finish", onNavigation);
    window.addEventListener("popstate", onNavigation);

    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method];
      history[method] = function patched(this: History, ...args: Parameters<History["pushState"]>) {
        const result = original.apply(this, args);
        queueMicrotask(onNavigation);
        return result;
      } as History[typeof method];
    }

    void load();
  },
});
