// Live playlist check of the packaged extension against real YouTube.
//
//   npm run build
//   npm run test:live:playlist -- "https://www.youtube.com/playlist?list=PLAYLIST_ID" "gradient"
//
// Drives the real side-panel UI in a plain Chromium process (see scripts/plain-chromium.mjs) and
// samples, once a second: the job, every window, which window has focus, the user's own tab URL,
// the side panel's scope, and the worker page's adapter sequence. Prints structure only.
import { launchPlainChromium, recordCaptionTraffic, recordMediaTraffic } from "./plain-chromium.mjs";

const rawTarget = process.argv[2];
const query = process.argv[3] ?? "gradient";
if (!rawTarget) throw new Error("Usage: npm run test:live:playlist -- PLAYLIST_URL [SEARCH_QUERY]");

const target = new URL(rawTarget);
const playlistId = target.searchParams.get("list");
if (
  target.protocol !== "https:" ||
  !/(^|\.)youtube\.com$/u.test(target.hostname) ||
  !["/playlist", "/watch"].includes(target.pathname) ||
  !playlistId ||
  !/^[A-Za-z0-9_-]{10,128}$/u.test(playlistId)
) {
  throw new Error("The live playlist smoke test requires an HTTPS YouTube playlist URL.");
}

const budgetMinutes = Number(process.env.RECALLTUBE_LIVE_BUDGET_MINUTES ?? 35);
const startedAt = Date.now();
const seconds = () => Math.round((Date.now() - startedAt) / 1000);
const session = await launchPlainChromium();
console.log(`[${seconds()}s] step: browser ready (${session.browserVersion})`);

try {
  const traffic = recordCaptionTraffic(session.context, startedAt);
  // Media the browser streamed while indexing: a worker that plays the video it only reads
  // captions from costs bandwidth for nothing. Counts and declared sizes only.
  const media = recordMediaTraffic(session.context);
  // Window/tab removals as the extension sees them, streamed from its service worker. If the run ends
  // because the browser went away, this separates "a window was closed" from "Chromium exited".
  const removals = [];
  session.serviceWorker.on("console", (message) => {
    if (message.text().startsWith("[trace]")) removals.push(`${seconds()}s ${message.text().slice(8)}`);
  });
  await session.serviceWorker
    .evaluate(() => {
      chrome.windows.onRemoved.addListener((id) => console.log(`[trace] window ${id} removed`));
      chrome.tabs.onRemoved.addListener((id, info) =>
        console.log(`[trace] tab ${id} removed from window ${info.windowId}${info.isWindowClosing ? " (window closing)" : ""}`)
      );
      chrome.windows.onCreated.addListener((window) => console.log(`[trace] window ${window.id} created (${window.type})`));
    })
    .catch(() => undefined);
  // RECALLTUBE_LIVE_THROTTLE="cpu=4,latency=300" slows every page, including each worker window as it
  // opens, to model a slower machine or connection. Timing-sensitive failures only show up there.
  const throttle = Object.fromEntries(
    (process.env.RECALLTUBE_LIVE_THROTTLE ?? "")
      .split(",")
      .filter(Boolean)
      .map((pair) => pair.split("=").map((part) => part.trim()))
  );
  if (throttle.cpu || throttle.latency) {
    const applyThrottle = async (page) => {
      const cdp = await session.context.newCDPSession(page).catch(() => undefined);
      if (!cdp) return;
      if (throttle.cpu) await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(throttle.cpu) }).catch(() => undefined);
      if (throttle.latency) {
        await cdp.send("Network.enable").catch(() => undefined);
        await cdp
          .send("Network.emulateNetworkConditions", {
            offline: false,
            latency: Number(throttle.latency),
            downloadThroughput: -1,
            uploadThroughput: -1,
          })
          .catch(() => undefined);
      }
    };
    // YouTube pages only: throttling the harness's own extension page stalled and closed it.
    session.context.on("page", (page) => {
      const apply = () => {
        if (!page.url().startsWith("chrome-extension://")) void applyThrottle(page);
      };
      if (page.url() === "about:blank" || page.url() === "") page.once("framenavigated", apply);
      else apply();
    });
  }
  const user = await session.context.newPage();
  const pageErrors = [];
  user.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 200)));
  await user.goto(target.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  console.log(`[${seconds()}s] step: user page loaded`);
  const userUrl = user.url();

  const panel = await session.context.newPage();
  const panelTrace = [];
  panel.on("console", (message) => { if (message.text().startsWith("[rt-trace]")) panelTrace.push(`${seconds()}s ${message.text().slice(11)}`); });
  await panel.goto(`chrome-extension://${session.extensionId}/sidepanel.html`);
  console.log(`[${seconds()}s] step: side panel loaded`);
  await user.bringToFront();
  // Lifecycle trace: if a run ends because a page or the browser went away, say which and when.
  const lifecycle = [];
  user.on("close", () => lifecycle.push(`${seconds()}s user tab closed`));
  panel.on("close", () => lifecycle.push(`${seconds()}s side-panel page closed`));
  session.browser.on("disconnected", () => lifecycle.push(`${seconds()}s browser disconnected`));
  const trace = { userWindowId: undefined };
  const inPanel = async (fn, arg) => {
    try {
      return await panel.evaluate(fn, arg);
    } catch (error) {
      const pages = session.browser.isConnected()
        ? session.context.pages().map((page) => page.url().replace(/[?#].*$/u, "")).join(", ")
        : "browser gone";
      console.error(JSON.stringify({ harnessStopped: error instanceof Error ? error.message.slice(0, 120) : String(error), lifecycle, remainingPages: pages, userWindowId: trace.userWindowId, lastRemovals: removals.slice(-12) }));
      throw error;
    }
  };
  const userWindowId = await inPanel(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.windowId,
    userUrl
  );
  trace.userWindowId = userWindowId;

  // RECALLTUBE_LIVE_REALISTIC=1 mirrors ordinary use: the user's window maximized and focused with
  // a video playing while the playlist indexes. A small idle window hid failures users hit.
  const realistic = process.env.RECALLTUBE_LIVE_REALISTIC === "1";
  if (realistic) {
    await inPanel(async (windowId) => chrome.windows.update(windowId, { state: "maximized", focused: true }), userWindowId);
    await user.bringToFront();
    await user
      .evaluate(async () => {
        const video = document.querySelector("video");
        if (video) {
          video.muted = true;
          await video.play().catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }

  await panel.getByRole("button", { name: "Entire playlist" }).waitFor({ timeout: 30_000 });
  await panel.getByRole("button", { name: "Entire playlist" }).dispatchEvent("click");
  await panel.getByRole("button", { name: "Index this playlist" }).waitFor({ timeout: 30_000 });
  await panel.getByRole("button", { name: "Index this playlist" }).dispatchEvent("click");
  console.log(`[${seconds()}s] step: indexing requested`);

  const observed = {
    samples: 0,
    samplesUserWindowNotFocused: 0,
    maxWorkerWindows: 0,
    workerWindowStates: new Set(),
    userTabUrlChanged: false,
    sidePanelLeftPlaylistView: 0,
    stagesByVideo: {},
  };
  let job;
  let timedOut = true;
  let lastLine = "";
  const deadline = Date.now() + budgetMinutes * 60_000;

  while (Date.now() < deadline) {
    const sample = await inPanel(
      async ({ id }) => {
        const response = await chrome.runtime.sendMessage({ type: "recalltube:playlist-get", playlistId: id });
        const windows = await chrome.windows.getAll({ populate: true });
        const focused = await chrome.windows.getLastFocused().catch(() => undefined);
        const popup = windows.find((window) => window.type === "popup");
        const workerTab = popup?.tabs?.[0];
        let worker;
        if (workerTab?.id !== undefined) {
          const reply = await new Promise((resolve) =>
            chrome.tabs.sendMessage(workerTab.id, { type: "recalltube:get-state" }, (value) =>
              resolve(chrome.runtime.lastError ? undefined : value)
            )
          );
          const snapshot = reply?.snapshot;
          if (snapshot?.videoId) {
            worker = {
              videoId: snapshot.videoId,
              transition: `${snapshot.generation}:${snapshot.status}${snapshot.reason ? `(${snapshot.reason})` : ""}${snapshot.progress ? `[${snapshot.progress.phase}${snapshot.progress.rows ? ` ${snapshot.progress.rows}` : ""}]` : ""}`,
              windowState: popup.state,
              adapters: (snapshot.diagnostics ?? [])
                .map((entry) => (entry.adapter === "content-script" ? `[${entry.detail}]` : `${entry.adapter}:${entry.outcome}`))
                .join(" > "),
              native: snapshot.diagnostics?.find((entry) => entry.adapter === "native-panel")?.detail,
            };
          }
        }
        return {
          job: response?.job,
          // Why a sample has no job: the coordinator did not answer (service worker gone), answered
          // with an error, or answered without a job.
          rawGet: response === undefined ? "no response" : response.ok ? (response.job ? "job" : "ok without job") : `error: ${response.error}`,
          workerWindows: windows.filter((window) => window.type === "popup").map((window) => window.state),
          focusedWindowId: focused?.focused ? focused.id : undefined,
          worker,
        };
      },
      { id: playlistId }
    );

    job = sample.job;
    observed.samples += 1;
    if (sample.focusedWindowId !== undefined && sample.focusedWindowId !== userWindowId) {
      observed.samplesUserWindowNotFocused += 1;
    }
    observed.maxWorkerWindows = Math.max(observed.maxWorkerWindows, sample.workerWindows.length);
    for (const state of sample.workerWindows) observed.workerWindowStates.add(state);
    if (user.url() !== userUrl) observed.userTabUrlChanged = true;
    const panelText = await panel.locator("body").innerText();
    if (!/PLAYLIST RECALL/u.test(panelText)) {
      observed.sidePanelLeftPlaylistView += 1;
      // Structure of what the panel showed instead: its first lines, never search results.
      const shape = panelText.split(String.fromCharCode(10)).filter(Boolean).slice(0, 4).join(" | ").slice(0, 160);
      observed.sidePanelShapes ??= [];
      if (!observed.sidePanelShapes.some((entry) => entry.endsWith(shape))) observed.sidePanelShapes.push(`${seconds()}s ${shape}`);
    }
    if (sample.worker?.adapters) {
      const record = (observed.stagesByVideo[sample.worker.videoId] ??= { sequences: [], native: undefined });
      if (!record.sequences.includes(sample.worker.adapters)) record.sequences.push(sample.worker.adapters);
      if (sample.worker.native) record.native = sample.worker.native;
    }
    if (sample.worker?.videoId) {
      const record = (observed.stagesByVideo[sample.worker.videoId] ??= { sequences: [], native: undefined });
      record.transitions ??= [];
      const entry = `${sample.worker.transition}@${sample.worker.windowState}`;
      if (record.transitions.at(-1)?.split(" ")[1] !== entry) record.transitions.push(`${seconds()}s ${entry}`);
    }

    const line = job ? `${job.state} ${job.items.map((item) => item.state).join(",")}` : `no job (${sample.rawGet})`;
    if (line !== lastLine) {
      console.log(`[${seconds()}s] ${line}`);
      lastLine = line;
    }
    if (job && ["completed", "failed", "cancelled"].includes(job.state) && job.workerTabId === undefined) {
      timedOut = false;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!job) throw new Error("No playlist indexing job was created.");

  const cueCounts = await inPanel(async (videoIds) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("recalltube");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise((resolve) => {
      const request = database.transaction("transcripts").objectStore("transcripts").getAll();
      request.onsuccess = () => resolve(request.result);
    });
    return Object.fromEntries(
      videoIds.map((id) => [id, records.find((record) => record.videoId === id)?.document?.cues?.length ?? 0])
    );
  }, job.items.map((item) => item.videoId));

  let search;
  const input = panel.getByLabel("Search playlist transcripts");
  if (await input.count()) {
    await input.fill(query);
    await panel.waitForTimeout(1_500);
    const cards = panel.locator(".playlist-result");
    const first = await cards.first().innerText().catch(() => "");
    search = {
      query,
      results: await cards.count(),
      first: first.split("\n").slice(0, 3).join(" | ").slice(0, 160),
    };
  }

  const remaining = await inPanel(async () =>
    (await chrome.windows.getAll({ populate: true })).map((window) => ({
      type: window.type,
      youtubeTabs: window.tabs.filter((tab) => tab.url?.includes("youtube.com")).length,
    }))
  );
  const finalFocus = await inPanel(async () => (await chrome.windows.getLastFocused()).id);

  const report = {
    browser: session.browserVersion,
    launch: "plain Chromium process (navigator.webdriver false), fresh signed-out profile",
    playlistId,
    title: job.playlistTitle,
    jobState: job.state,
    timedOut,
    budgetMinutes,
    lastError: job.lastError,
    realistic,
    throttle,
    coverage: job.items.map((item) => ({
      position: item.position + 1,
      videoId: item.videoId,
      state: item.state,
      attempts: item.attempts,
      failureDiagnostics: item.diagnostics?.map((entry) => `${entry.adapter}:${entry.outcome}: ${entry.detail}`),
      failureReason: item.failureReason,
      cues: cueCounts[item.videoId],
      stages: observed.stagesByVideo[item.videoId]?.sequences,
      workerTransitions: observed.stagesByVideo[item.videoId]?.transitions,
      native: observed.stagesByVideo[item.videoId]?.native ?? item.diagnostics?.find((entry) => entry.adapter === "native-panel")?.detail,
    })),
    worker: {
      maxWorkerWindows: observed.maxWorkerWindows,
      windowStatesSeen: [...observed.workerWindowStates],
      closedAtEnd: job.workerTabId === undefined && remaining.every((window) => window.type !== "popup"),
    },
    user: {
      tabUrlUnchanged: !observed.userTabUrlChanged && user.url() === userUrl,
      samples: observed.samples,
      samplesUserWindowNotFocused: observed.samplesUserWindowNotFocused,
      focusOnUserWindowAtEnd: finalFocus === userWindowId,
      sidePanelLeftPlaylistViewSamples: observed.sidePanelLeftPlaylistView,
      sidePanelInstead: observed.sidePanelShapes?.slice(0, 6),
    },
    remainingWindows: remaining,
    panelTrace: panelTrace.slice(0, 40),
    search,
    mediaTraffic: media,
    captionTraffic: traffic,
    pageErrors,
  };
  console.log(JSON.stringify(report, null, 2));

  if (
    timedOut ||
    job.state !== "completed" ||
    !report.worker.closedAtEnd ||
    !report.user.tabUrlUnchanged ||
    !search?.results
  ) {
    process.exitCode = 2;
  }
} finally {
  await session.close();
}
