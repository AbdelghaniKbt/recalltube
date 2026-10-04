import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserContext } from "playwright";
import { launch, type Harness } from "./harness";
import {
  ENGLISH_TALK,
  findFixture,
  playlistPageHtml,
  PLAYLIST_NO_CAPTIONS,
  PLAYLIST_NATIVE,
  PLAYLIST_SECOND,
  watchPageHtml,
} from "./fixtures";


const PLAYLIST_ID = "PLrecalltube0001";
const PLAYLIST_FIXTURES = [ENGLISH_TALK, PLAYLIST_SECOND, PLAYLIST_NATIVE, PLAYLIST_NO_CAPTIONS];
let harness: Harness;

async function mockYouTube(context: BrowserContext) {
  await context.route(/^https:\/\/www\.youtube\.com\/api\/timedtext/, async (route) => {
    const url = new URL(route.request().url());
    const fixture = findFixture(url.searchParams.get("v"));
    if (fixture?.emptyBody) return route.fulfill({ status: 200, body: "" });
    if (!fixture?.json3) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture.json3) });
  });
  await context.route(/^https:\/\/www\.youtube\.com\/watch/, async (route) => {
    const url = new URL(route.request().url());
    const fixture = findFixture(url.searchParams.get("v")) ?? ENGLISH_TALK;
    const playlist = url.searchParams.get("list") === PLAYLIST_ID ? PLAYLIST_FIXTURES : [];
    return route.fulfill({ status: 200, contentType: "text/html", body: watchPageHtml(fixture, playlist) });
  });
  await context.route(/^https:\/\/www\.youtube\.com\/playlist/, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: playlistPageHtml(PLAYLIST_FIXTURES) })
  );
}

/**
 * A fresh profile per test keeps storage, service-worker recovery and ownership deterministic.
 * Worker windows start at about:blank and navigate only after Chrome attaches them, so every
 * mocked watch request is observable before it starts.
 */
beforeEach(async () => {
  harness = await launch();
  await mockYouTube(harness.context);
}, 120_000);

afterEach(async () => harness?.close());

describe("playlist indexing", () => {
  it("never lets a URL fragment demote an ordinary user tab to direct-only acquisition", async () => {
    // Worker role used to be read from `#recalltube-playlist-worker`. Any shared link can carry a
    // fragment, and a user tab opened from one silently lost its native-transcript fallback. The
    // role now comes from session-scoped ownership of tabs this extension created.
    const watch = await harness.context.newPage();
    await watch.goto(`https://www.youtube.com/watch?v=${PLAYLIST_NATIVE.id}#recalltube-playlist-worker`);
    const control = await harness.openSidePanel();
    await watch.bringToFront();

    const read = () => control.evaluate(async (videoId) => {
      const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url?.includes(videoId));
      if (!tab?.id) throw new Error("Fixture tab not found.");
      return chrome.tabs.sendMessage(tab.id, { type: "recalltube:get-state" });
    }, PLAYLIST_NATIVE.id);
    await expect.poll(async () => (await read())?.snapshot?.status, { timeout: 30_000 }).toBe("ready");
    const snapshot = (await read()).snapshot;
    expect(snapshot?.document?.cues).toHaveLength(2);
    expect(snapshot?.diagnostics?.map((entry: { adapter: string; outcome: string; detail: string }) =>
      entry.adapter === "content-script" ? entry.detail : `${entry.adapter}:${entry.outcome}`
    )).toEqual([
      "attempt 1 started by initial in automatic mode",
      "player-track:failed",
      "native-panel:ok",
    ]);

    await control.close();
    await watch.close();
  }, 60_000);

  it("runs an explicit native request even while a direct-only attempt is still loading", async () => {
    // Live, a native-panel request that arrived during another attempt was coalesced into it and
    // silently dropped, so the playlist item never reached its native stage.
    const watch = await harness.context.newPage();
    await watch.goto(`https://www.youtube.com/watch?v=${PLAYLIST_NATIVE.id}`);
    const control = await harness.openSidePanel();
    await watch.bringToFront();

    const outcome = await control.evaluate(async (videoId) => {
      const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url?.includes(videoId));
      if (!tab?.id) throw new Error("Fixture tab not found.");
      const tabId = tab.id;
      // Bounded, so a lost reply fails this test with a record instead of hanging the whole suite.
      const trace: string[] = [];
      const send = (message: { type: string; acquisitionMode?: string }) =>
        Promise.race([
          chrome.tabs.sendMessage(tabId, message),
          new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 5_000)),
        ]).then((reply: any) => {
          if (reply?.timedOut) trace.push(`timeout:${message.type}:${message.acquisitionMode ?? ""}`);
          return reply;
        });
      // Let the automatic first attempt settle, then start a direct-only attempt and, while it is
      // loading, ask for the native panel.
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const state = await send({ type: "recalltube:get-state" });
        if (state?.snapshot?.status === "ready" || state?.snapshot?.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await send({ type: "recalltube:refresh", acquisitionMode: "direct-only" });
      const nativeStart = await send({ type: "recalltube:refresh", acquisitionMode: "native-panel" });
      let snapshot;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        snapshot = (await send({ type: "recalltube:get-state" }))?.snapshot;
        if (snapshot?.generation >= nativeStart.generation && snapshot?.status !== "loading") break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return { nativeGeneration: nativeStart?.generation, snapshot, trace };
    }, PLAYLIST_NATIVE.id);

    expect(outcome.trace, JSON.stringify(outcome)).toEqual([]);
    expect(outcome.snapshot?.generation).toBe(outcome.nativeGeneration);
    expect(outcome.snapshot?.status).toBe("ready");
    expect(outcome.snapshot?.diagnostics?.[0]?.detail).toBe(
      `attempt ${outcome.nativeGeneration} started by refresh in native-panel mode`
    );
    await control.close();
    await watch.close();
  }, 60_000);

  it("does not restart acquisition when YouTube rewrites the URL of the same video", async () => {
    const watch = await harness.context.newPage();
    await watch.goto(`https://www.youtube.com/watch?v=${PLAYLIST_SECOND.id}`);
    const control = await harness.openSidePanel();
    await watch.bringToFront();
    const read = () => control.evaluate(async (videoId) => {
      const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url?.includes(videoId));
      return tab?.id === undefined ? undefined : (await chrome.tabs.sendMessage(tab.id, { type: "recalltube:get-state" }))?.snapshot;
    }, PLAYLIST_SECOND.id);
    await expect.poll(async () => (await read())?.status, { timeout: 30_000 }).toBe("ready");
    const before = (await read())?.generation;

    // YouTube announces its own URL updates with `yt-navigate-finish`, the event the content script
    // follows (a page-world `replaceState` is invisible to the isolated world's history patch).
    await watch.evaluate(() => {
      history.replaceState({}, "", `${location.pathname}${location.search}&pp=tracking&t=12s`);
      window.dispatchEvent(new CustomEvent("yt-navigate-finish"));
    });
    await watch.waitForTimeout(1_500);
    expect((await read())?.generation).toBe(before);
    expect((await read())?.status).toBe("ready");

    await control.close();
    await watch.close();
  }, 60_000);

  it("stays on the playlist when one playlist lookup fails during a refresh", async () => {
    // Live, the side panel dropped from the playlist view to "This video" mid-job and stayed there:
    // a single failed lookup cleared the inventory. Here YouTube's page stops answering the bridge,
    // as a page too busy to reply within the timeout does, and a tab switch triggers a refresh.
    const watch = await harness.context.newPage();
    await watch.goto(`https://www.youtube.com/watch?v=${PLAYLIST_SECOND.id}&list=${PLAYLIST_ID}`);
    const panel = await harness.openSidePanel();
    await watch.bringToFront();
    await panel.getByRole("button", { name: "Entire playlist" }).waitFor({ timeout: 15_000 });
    await panel.getByRole("button", { name: "Entire playlist" }).click();
    await panel.getByText("PLAYLIST RECALL").waitFor({ timeout: 15_000 });

    await watch.evaluate(() => {
      const original = window.postMessage.bind(window);
      window.postMessage = ((message: unknown, ...rest: unknown[]) => {
        if ((message as { type?: string } | null)?.type === "recalltube:page-data") return;
        return (original as (...args: unknown[]) => void)(message, ...rest);
      }) as typeof window.postMessage;
    });
    await panel.bringToFront();
    await watch.bringToFront();
    // The lookup times out after 3 s; give the refresh time to finish.
    await panel.waitForTimeout(6_000);

    expect(await panel.getByText("PLAYLIST RECALL").count()).toBeGreaterThan(0);
    await panel.close();
    await watch.close();
  }, 60_000);

  it("keeps native capture connected when Chrome moves the worker into a popup", async () => {
    const watch = await harness.context.newPage();
    await watch.goto(`https://www.youtube.com/watch?v=${PLAYLIST_NATIVE.id}`);
    await watch.waitForTimeout(2_000);
    const control = await harness.openSidePanel();
    await watch.bringToFront();

    const outcome = await control.evaluate(async (videoId) => {
      const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url?.includes(videoId));
      if (!tab?.id) throw new Error("Worker fixture tab not found.");
      const popup = await chrome.windows.create({ tabId: tab.id, focused: false, state: "minimized", type: "popup" });
      if (popup?.id !== undefined && popup.state !== "minimized") {
        await chrome.windows.update(popup.id, { state: "minimized" });
      }
      await chrome.tabs.sendMessage(tab.id, { type: "recalltube:refresh", acquisitionMode: "native-panel" });
      let response;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        response = await chrome.tabs.sendMessage(tab.id, { type: "recalltube:get-state" });
        if (response?.snapshot?.status !== "loading") break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (popup?.id !== undefined) await chrome.windows.remove(popup.id);
      return response?.snapshot;
    }, PLAYLIST_NATIVE.id);

    expect(outcome, JSON.stringify(outcome?.diagnostics)).toMatchObject({ status: "ready" });
    expect(outcome?.document?.cues).toHaveLength(2);
    await control.close();
  }, 60_000);

  it("indexes without a key, searches across videos, and closes its worker", async () => {
    const watch = await harness.context.newPage();
    await watch.goto(`https://www.youtube.com/watch?v=${ENGLISH_TALK.id}&list=${PLAYLIST_ID}`);
    await watch.waitForTimeout(2_000);
    const ownerUrl = watch.url();
    const panel = await harness.openSidePanel();
    await watch.bringToFront();

    await panel.getByRole("button", { name: "Entire playlist" }).waitFor({ timeout: 15_000 });
    await panel.getByRole("button", { name: "Entire playlist" }).click();
    await panel.getByRole("button", { name: "Index this playlist" }).dispatchEvent("click");

    const readJob = () => panel.evaluate(async ({ playlistId, nativeId }) => {
      const response = await chrome.runtime.sendMessage({ type: "recalltube:playlist-get", playlistId });
      if (!response?.job) return undefined;
      return {
        state: response.job.state,
        items: response.job.items.map((item: any) => [item.videoId, item.state, item.failureReason]),
        nativeDiagnostics: response.job.items.find((item: any) => item.videoId === nativeId)?.diagnostics,
        workerTabId: response.job.workerTabId,
        workerWindowId: response.job.workerWindowId,
      };
    }, { playlistId: PLAYLIST_ID, nativeId: PLAYLIST_NATIVE.id });
    await expect.poll(async () => (await readJob())?.state, { timeout: 90_000 }).toBe("completed");
    const finished = await readJob();
    expect(finished, JSON.stringify({ diagnostics: finished?.nativeDiagnostics })).toEqual({
      state: "completed",
      items: [
        [ENGLISH_TALK.id, "cached", undefined],
        [PLAYLIST_SECOND.id, "indexed", undefined],
        [PLAYLIST_NATIVE.id, "indexed", undefined],
        [PLAYLIST_NO_CAPTIONS.id, "no-captions", "no-captions"],
      ],
      nativeDiagnostics: undefined,
      workerTabId: undefined,
      workerWindowId: undefined,
    });
    await panel.getByText("3 of 4 videos searchable").waitFor({ timeout: 15_000 });
    await panel.getByLabel("Search playlist transcripts").fill("anomaly detection");
    await panel.getByText("Playlist anomaly-detection lecture", { exact: true }).waitFor({ timeout: 15_000 });
    await panel.getByLabel("Search playlist transcripts").fill("native playlist fallback");
    await panel.getByText("Playlist native-panel fallback", { exact: true }).waitFor({ timeout: 15_000 });

    expect(watch.url()).toBe(ownerUrl);
    const youtubeTabs = await panel.evaluate(async () =>
      (await chrome.tabs.query({})).filter((tab) => tab.url?.startsWith("https://www.youtube.com/")).map((tab) => tab.url)
    );
    expect(youtubeTabs).toEqual([ownerUrl]);

    // Clicking a result must open that video *in playlist context*, at the matched second. This is
    // the whole promise of playlist search and nothing asserted the produced URL before.
    await panel.getByLabel("Search playlist transcripts").fill("anomaly detection");
    await panel.getByText("Playlist anomaly-detection lecture", { exact: true }).waitFor({ timeout: 15_000 });
    const card = panel.locator(".playlist-result").first();
    const clock = (await card.locator(".timestamp").first().innerText()).replace(/[^\d:]/gu, "");
    const seconds = clock
      .split(":")
      .map(Number)
      .reduce((total, part) => total * 60 + part, 0);
    await card.locator(".result-main").click();
    const expected =
      `https://www.youtube.com/watch?v=${PLAYLIST_SECOND.id}&list=${PLAYLIST_ID}` +
      (seconds > 0 ? `&t=${seconds}s` : "");
    await expect.poll(() => watch.url(), { timeout: 15_000 }).toBe(expected);

    await panel.close();
    await watch.close();
  }, 120_000);

  it("stops on cancel, leaves no worker, and keeps what it already indexed searchable", async () => {
    const watch = await harness.context.newPage();
    await watch.goto(`https://www.youtube.com/watch?v=${ENGLISH_TALK.id}&list=${PLAYLIST_ID}`);
    await watch.waitForTimeout(2_000);
    const ownerUrl = watch.url();
    const panel = await harness.openSidePanel();
    await watch.bringToFront();
    await panel.getByRole("button", { name: "Entire playlist" }).waitFor({ timeout: 15_000 });
    await panel.getByRole("button", { name: "Entire playlist" }).click();
    await panel.getByRole("button", { name: "Index this playlist" }).dispatchEvent("click");

    const readState = () => panel.evaluate(async (playlistId) => {
      const response = await chrome.runtime.sendMessage({ type: "recalltube:playlist-get", playlistId });
      return response?.job
        ? { state: response.job.state, jobId: response.job.jobId, workerTabId: response.job.workerTabId }
        : undefined;
    }, PLAYLIST_ID);

    // Same budget as the full indexing test: the captionless fixture's page never renders a
    // transcript control, and a built page now gets 15 s for it before being called unavailable —
    // deliberately, because a slow page's late control was misreported as "no captions".
    await expect.poll(async () => (await readState())?.state, { timeout: 90_000 }).toBe("completed");
    const jobId = (await readState())!.jobId;

    await panel.evaluate(
      async (id) => chrome.runtime.sendMessage({ type: "recalltube:playlist-cancel", jobId: id }),
      jobId
    );

    // Cancelling must be terminal: no resurrection into `running`, and no worker left behind.
    await panel.waitForTimeout(2_500);
    const after = await readState();
    expect(after?.state).toBe("cancelled");
    expect(after?.workerTabId).toBeUndefined();

    const remaining = await panel.evaluate(async () =>
      (await chrome.tabs.query({})).filter((tab) => tab.url?.startsWith("https://www.youtube.com/")).map((tab) => tab.url)
    );
    expect(remaining).toEqual([ownerUrl]);

    // Transcripts acquired before the cancel stay searchable.
    await panel.getByLabel("Search playlist transcripts").fill("anomaly detection");
    await panel.getByText("Playlist anomaly-detection lecture", { exact: true }).waitFor({ timeout: 15_000 });

    await panel.close();
    await watch.close();
  }, 120_000);
});
