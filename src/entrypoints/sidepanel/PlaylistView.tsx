import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { SemanticSearchClient } from "../../ai/semantic-client";
import { DEFAULT_MODEL_ID } from "../../ai/models";
import type { ModelStatus } from "../../ai/protocol";
import { askPlaylist, type AskOutcome } from "../../ask";
import { matchLabel } from "../../search/hybrid-ranker";
import { renderableMatch } from "../../search/highlight";
import { loadTranscriptsForVideos } from "../../storage/indexeddb";
import type { ContentResponse } from "../../types/messages";
import type { PlaylistIndexJob, PlaylistInventory, PlaylistSearchResult, PlaylistTranscript } from "../../types/playlist";
import type { SearchResult } from "../../types/transcript";
import { MAX_AUTOMATIC_ATTEMPTS, playlistCoverage } from "../../playlist/job";
import { parsePlaylistJobChanged, type PlaylistCommandResponse } from "../../playlist/messages";
import { buildPlaylistRetrieval, searchPlaylist } from "../../playlist/search";
import { playlistPageUrl, playlistWatchUrl } from "../../playlist/url";
import { embeddableChunks, type RetrievalIndex } from "../../search/engine";
import { formatTime, playlistTimestampedLink } from "./format";

type Mode = "exact" | "meaning" | "ask";

async function command(message: unknown): Promise<PlaylistCommandResponse> {
  return browser.runtime.sendMessage(message) as Promise<PlaylistCommandResponse>;
}

/**
 * Reads a lazily-paginated playlist through a temporary tab.
 *
 * The tab is created by the side panel, which Chrome destroys whenever the user closes it — so the
 * `finally` that removes it is not on its own a guarantee. The id is therefore also recorded in
 * session storage under {@link INVENTORY_TAB_KEY} before the tab is used, so the background sweep
 * can close it by id if this surface disappears mid-read.
 */
export const INVENTORY_TAB_KEY = "recalltube:inventory-tab";

async function rememberInventoryTab(tabId: number | undefined): Promise<void> {
  await browser.storage.session
    .set({ [INVENTORY_TAB_KEY]: tabId ?? null })
    .catch(() => undefined);
}

async function completeInventory(
  ownerTabId: number,
  initial: PlaylistInventory,
  signal: AbortSignal
): Promise<PlaylistInventory> {
  if (initial.complete) return initial;
  // Chrome rejects tabs.create outright when the opener no longer exists.
  const opener = await browser.tabs.get(ownerTabId).catch(() => undefined);
  const tab = await browser.tabs.create({
    active: false,
    openerTabId: opener?.id,
    url: playlistPageUrl(initial.playlistId),
  });
  if (tab.id === undefined) throw new Error("Chrome could not create the playlist inventory tab.");
  await rememberInventoryTab(tab.id);
  try {
    await browser.tabs.update(tab.id, { active: false, muted: true }).catch(() => undefined);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const response = await (browser.tabs.sendMessage(tab.id, {
        type: "recalltube:get-playlist",
        complete: true,
      }) as Promise<ContentResponse>).catch(() => undefined);
      if (response?.ok && response.playlist?.items.length) return response.playlist;
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    }
    throw new Error("YouTube did not finish loading the playlist inventory.");
  } finally {
    await browser.tabs.remove(tab.id).catch(() => undefined);
    await rememberInventoryTab(undefined);
  }
}

export function PlaylistView({
  tabId,
  inventory,
  aiEnabled,
  askEnabled,
  onEnableAi,
  semanticClient,
}: {
  tabId: number;
  inventory: PlaylistInventory;
  aiEnabled: boolean;
  askEnabled: boolean;
  onEnableAi: () => Promise<void>;
  /** The panel's single semantic client, so this view never loads a second model instance. */
  semanticClient: () => SemanticSearchClient;
}) {
  const [job, setJob] = useState<PlaylistIndexJob>();
  const [mode, setMode] = useState<Mode>("exact");
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<PlaylistTranscript[]>([]);
  const [semantic, setSemantic] = useState<Map<string, SearchResult[]>>(new Map());
  const [semanticReady, setSemanticReady] = useState<string[]>([]);
  const [modelStatus, setModelStatus] = useState<ModelStatus>({ phase: "idle", message: "" });
  const [working, setWorking] = useState(false);
  const [answer, setAnswer] = useState<AskOutcome>();
  const [notice, setNotice] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const indexAbort = useRef<AbortController | undefined>(undefined);
  const searchAbort = useRef<AbortController | undefined>(undefined);
  const askAbort = useRef<AbortController | undefined>(undefined);
  const startAbort = useRef<AbortController | undefined>(undefined);

  const itemSource = job?.items ?? inventory.items;
  const sourceKey = itemSource
    .map((item) => `${item.videoId}:${"transcriptId" in item ? item.transcriptId ?? "" : ""}:${"state" in item ? item.state : ""}`)
    .join("|");

  const refreshJob = useCallback(async () => {
    const response = await command({ type: "recalltube:playlist-get", playlistId: inventory.playlistId }).catch(() => undefined);
    if (response?.ok) setJob(response.job);
  }, [inventory.playlistId]);

  useEffect(() => {
    void refreshJob();
    const listener = (raw: unknown, sender: chrome.runtime.MessageSender) => {
      if (sender.id && sender.id !== browser.runtime.id) return;
      const changed = parsePlaylistJobChanged(raw);
      if (changed?.job.playlistId === inventory.playlistId) setJob(changed.job);
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [inventory.playlistId, refreshJob]);

  useEffect(() => {
    let live = true;
    const items = itemSource;
    void loadTranscriptsForVideos(items.map((item) => item.videoId)).then((stored) => {
      if (!live) return;
      setEntries(
        items.flatMap((item) => {
          const transcript = stored.get(item.videoId)?.document;
          return transcript ? [{ item, transcript }] : [];
        })
      );
    });
    return () => {
      live = false;
    };
  }, [sourceKey]);

  /** Retrieval indexes by transcript id, so a job update only builds what changed. */
  const indexCache = useRef(new Map<string, RetrievalIndex>());
  const corpus = useMemo(() => buildPlaylistRetrieval(entries, indexCache.current), [entries]);
  const results = useMemo(
    () =>
      searchPlaylist(inventory.playlistId, corpus, query, {
        mode: mode === "exact" ? "exact" : "meaning",
        semantic,
        limit: 50,
      }),
    [corpus, inventory.playlistId, mode, query, semantic]
  );

  useEffect(() => {
    setSemantic(new Map());
    setAnswer(undefined);
    setActiveIndex(0);
  }, [query, mode]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, results]);

  // Model status from the shared worker, whichever surface asked for the work.
  useEffect(() => {
    if (!aiEnabled) return;
    return semanticClient().addStatusListener(setModelStatus);
  }, [aiEnabled, semanticClient]);

  useEffect(() => {
    if (mode === "exact" || !aiEnabled || !corpus.length) return;
    const readyAtStart = new Set(semanticReady);
    const missing = corpus.filter((entry) => !readyAtStart.has(entry.transcript.transcriptId));
    if (!missing.length) return;
    const client = semanticClient();
    indexAbort.current?.abort();
    const controller = new AbortController();
    indexAbort.current = controller;
    setWorking(true);
    void (async () => {
      // Each transcript is recorded the moment it is embedded. Committing the batch at the end
      // meant a playlist that was still acquiring — where `corpus` grows and re-runs this effect —
      // aborted the loop and threw away every transcript it had just embedded, so meaning search
      // could never converge while indexing was in flight.
      for (let position = 0; position < missing.length; position += 1) {
        const entry = missing[position]!;
        setModelStatus({
          phase: "indexing",
          message: `Understanding video ${position + 1} of ${missing.length}…`,
          indexed: position,
          total: missing.length,
          progress: (position / missing.length) * 100,
        });
        await client.index(
          {
            transcriptId: entry.transcript.transcriptId,
            videoId: entry.item.videoId,
            modelKey: DEFAULT_MODEL_ID,
            preferredBackend: "webgpu",
            chunks: embeddableChunks(entry.index),
          },
          controller.signal
        );
        setSemanticReady((current) =>
          current.includes(entry.transcript.transcriptId)
            ? current
            : [...current, entry.transcript.transcriptId]
        );
      }
    })()
      .catch((error: Error) => {
        if (error.name !== "AbortError") setModelStatus({ phase: "failed", message: error.message });
      })
      .finally(() => setWorking(false));
    return () => controller.abort();
  }, [aiEnabled, corpus, mode, semanticClient]);

  const readyKey = semanticReady.join("|");
  useEffect(() => {
    if (mode === "exact" || !aiEnabled || query.trim().length < 2 || !semanticReady.length) return;
    const timer = window.setTimeout(() => {
      searchAbort.current?.abort();
      const controller = new AbortController();
      searchAbort.current = controller;
      setWorking(true);
      void semanticClient()
        .searchMany(semanticReady, query.trim(), 8, controller.signal)
        .then(setSemantic)
        .catch((error: Error) => {
          if (error.name !== "AbortError") setModelStatus({ phase: "failed", message: error.message });
        })
        .finally(() => setWorking(false));
    }, 240);
    return () => window.clearTimeout(timer);
  }, [aiEnabled, mode, query, readyKey, semanticClient]);

  // A side panel is torn down without warning whenever the user closes it. Abort the inventory
  // read and close its tab on the way out; `pagehide` covers the teardown React never sees.
  useEffect(() => {
    const release = () => {
      startAbort.current?.abort();
      void browser.storage.session
        .get(INVENTORY_TAB_KEY)
        .then((stored) => {
          const tabId = stored?.[INVENTORY_TAB_KEY];
          if (typeof tabId !== "number") return undefined;
          return browser.tabs.remove(tabId).catch(() => undefined);
        })
        .catch(() => undefined);
    };
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      release();
    };
  }, []);

  const start = async () => {
    startAbort.current?.abort();
    const controller = new AbortController();
    startAbort.current = controller;
    setWorking(true);
    setNotice("Reading the complete playlist…");
    try {
      const collected = await completeInventory(tabId, inventory, controller.signal);
      const response = await command({ type: "recalltube:playlist-start", inventory: collected, ownerTabId: tabId });
      if (!response.ok || !response.job) throw new Error(response.error ?? "Could not start playlist indexing.");
      setJob(response.job);
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not start playlist indexing.");
    } finally {
      setWorking(false);
    }
  };

  const act = async (type: string) => {
    if (!job) return;
    const response = await command({ type, jobId: job.jobId });
    if (response.ok && response.job) setJob(response.job);
    else setNotice(response.error ?? "Playlist action failed.");
  };

  const openMoment = async (entry: PlaylistSearchResult, seconds = entry.result.start) => {
    await browser.tabs.update(tabId, { url: playlistWatchUrl(inventory.playlistId, entry.item.videoId, seconds) });
  };

  const runAsk = async () => {
    if (query.trim().length < 3 || !results.length) return;
    askAbort.current?.abort();
    const controller = new AbortController();
    askAbort.current = controller;
    setWorking(true);
    try {
      setAnswer(await askPlaylist(query.trim(), results, { allowPromptApi: askEnabled, signal: controller.signal }));
    } finally {
      setWorking(false);
    }
  };

  const coverage = job ? playlistCoverage(job) : undefined;
  const canRetry = job?.items.some((item) => item.state === "failed" || item.state === "indexing");
  const indexingItem = job?.items.find((item) => item.state === "indexing");
  const isTerminal = job && ["completed", "cancelled", "failed"].includes(job.state);

  return (
    <main className="playlist-view">
      <section className="playlist-hero">
        <div className="eyebrow"><span className="live-dot" aria-hidden="true" /> PLAYLIST RECALL</div>
        <h1>{job?.playlistTitle ?? inventory.title ?? "YouTube playlist"}</h1>
        <p className="playlist-coverage">
          {coverage
            ? `${coverage.searchable} of ${coverage.total} videos searchable`
            : `${inventory.items.length}${inventory.complete ? "" : "+"} videos discovered`}
        </p>
        {job ? (
          <>
            <div className="coverage-bar" aria-label={`${coverage?.searchable ?? 0} of ${coverage?.total ?? 0} searchable`}>
              <span style={{ width: `${coverage?.total ? ((coverage.searchable / coverage.total) * 100) : 0}%` }} />
            </div>
            <div className="coverage-details">
              <span>{coverage?.searchable ?? 0} ready</span>
              <span>{coverage?.pending ?? 0} remaining</span>
              <span>{coverage?.unavailable ?? 0} unavailable</span>
              <span>{coverage?.failed ?? 0} retry</span>
            </div>
            {indexingItem && (
              <p className="playlist-current" role="status">
                <span className="playlist-spinner" aria-hidden="true" />
                {indexingItem.attempts > 1 ? "Retrying" : "Indexing"} {indexingItem.position + 1} of {job.items.length}: {indexingItem.title}
                {indexingItem.attempts > 1 && ` (attempt ${indexingItem.attempts} of ${MAX_AUTOMATIC_ATTEMPTS})`}
              </p>
            )}
            <div className="playlist-actions">
              {(job.state === "running" || job.state === "queued") && <button onClick={() => void act("recalltube:playlist-pause")}>Pause</button>}
              {job.state === "paused" && <button className="primary-button" onClick={() => void act("recalltube:playlist-resume")}>Resume</button>}
              {canRetry && job.state !== "running" && <button onClick={() => void act("recalltube:playlist-retry")}>Retry failures</button>}
              {isTerminal && <button onClick={() => void start()}>Refresh playlist</button>}
              {(job.state === "running" || job.state === "paused" || job.state === "queued") && <button onClick={() => void act("recalltube:playlist-cancel")}>Cancel</button>}
            </div>
          </>
        ) : (
          <button className="primary-button index-playlist" disabled={working} onClick={() => void start()}>
            {working ? "Preparing playlist…" : "Index this playlist"}
          </button>
        )}
        {notice && <p className="playlist-notice" role="status">{notice}</p>}
      </section>

      {entries.length > 0 && (
        <>
          <section className="search-area playlist-search">
            <div className="mode-tabs" role="tablist" aria-label="Playlist search mode">
              {(["exact", "meaning", "ask"] as const).map((value) => (
                <button
                  key={value}
                  role="tab"
                  id={`playlist-tab-${value}`}
                  aria-selected={mode === value}
                  aria-controls="playlist-results-panel"
                  className={mode === value ? "active" : ""}
                  onClick={() => setMode(value)}
                >
                  {value === "exact" ? "Exact" : value === "meaning" ? "Meaning" : "Ask"}
                </button>
              ))}
            </div>
            <label className="search-box">
              <span aria-hidden="true">⌕</span>
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setQuery("");
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (mode === "ask") void runAsk();
                    else if (results[activeIndex]) void openMoment(results[activeIndex]!);
                  }
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveIndex((current) => {
                      const next = event.key === "ArrowDown" ? current + 1 : current - 1;
                      return Math.max(0, Math.min(results.length - 1, next));
                    });
                  }
                }}
                placeholder={mode === "exact" ? "Search every indexed video…" : mode === "meaning" ? "Describe what you remember…" : "Ask this playlist…"}
                aria-label="Search playlist transcripts"
              />
            </label>
            {mode !== "exact" && !aiEnabled && (
              <button className="primary-button" onClick={() => void onEnableAi()}>Enable local meaning search</button>
            )}
            {mode !== "exact" && aiEnabled && modelStatus.message && <p className="semantic-progress">{modelStatus.message}</p>}
            {mode === "ask" && <button className="primary-button" disabled={working || query.trim().length < 3} onClick={() => void runAsk()}>{working ? "Reading evidence…" : "Answer from this playlist"}</button>}
          </section>

          {answer && (
            <section className="answer-card playlist-answer">
              <p className="answer-text">{answer.answer}</p>
              <ul className="citations">
                {answer.citations.map((citation) => {
                  const evidence = answer.evidence.find((item) => item.id === citation.evidenceId);
                  return <li key={citation.evidenceId}><button className="citation" onClick={() => {
                    if (!evidence?.videoId) return;
                    void browser.tabs.update(tabId, { url: playlistWatchUrl(inventory.playlistId, evidence.videoId, citation.start) });
                  }}><span className="timestamp">{formatTime(citation.start)}</span><span>{evidence?.videoTitle}</span><span>{evidence?.text}</span></button></li>;
                })}
              </ul>
            </section>
          )}

          <section
            className="results-section"
            id="playlist-results-panel"
            role="tabpanel"
            aria-labelledby={`playlist-tab-${mode}`}
          >
            {query.trim().length < 2 ? (
              <div className="prompt-state"><p>Search across {entries.length} indexed {entries.length === 1 ? "video" : "videos"}.</p></div>
            ) : results.length ? (
              <>
                <div className="result-count"><span>{results.length} moments across the playlist</span>{working && <span className="muted">updating…</span>}</div>
                <div aria-live="polite" className="visually-hidden">
                  {results.length} {results.length === 1 ? "moment" : "moments"} found across the playlist
                </div>
                <div className="result-list" ref={listRef} role="listbox" aria-label="Playlist search results">
                  {results.map((entry, position) => {
                    const rendered = renderableMatch(entry.result, entry.transcript.cues);
                    const active = position === activeIndex;
                    return (
                      <article
                        className={`result-card playlist-result${active ? " active" : ""}`}
                        key={entry.result.id}
                        role="option"
                        aria-selected={active}
                        data-active={active}
                      >
                        <button className="result-main" onClick={() => void openMoment(entry)} onFocus={() => setActiveIndex(position)}>
                          <span className="playlist-result-video"><span className="playlist-position">{entry.item.position + 1}</span><span>{entry.item.title}</span></span>
                          <span className="result-head"><span className="timestamp">▶ {formatTime(entry.result.start)}</span><span className="match-kind">{matchLabel(entry.result.signals)}</span></span>
                          <span className="result-text">{rendered.text}</span>
                        </button>
                        <div className="result-actions">
                          <button onClick={() => void openMoment(entry, Math.max(0, entry.result.start - 15))}>−15s</button>
                          <button onClick={() => void navigator.clipboard.writeText(playlistTimestampedLink(inventory.playlistId, entry.item.videoId, entry.result.start))}>Link</button>
                          <button onClick={() => void navigator.clipboard.writeText(`"${entry.result.text}" — ${entry.item.title}, ${formatTime(entry.result.start)}\n${playlistTimestampedLink(inventory.playlistId, entry.item.videoId, entry.result.start)}`)}>Quote</button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </>
            ) : <div className="no-results"><h2>No moments found</h2><p>Try fewer words or describe the idea differently.</p></div>}
          </section>
        </>
      )}
    </main>
  );
}
