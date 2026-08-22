import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { SemanticSearchClient } from "../../ai/semantic-client";
import type { ModelStatus } from "../../ai/protocol";
import { DEFAULT_MODEL_ID, modelDescriptor } from "../../ai/models";
import { ask, promptApiLanguage, type AskOutcome } from "../../ask";
import { buildRetrievalIndex, embeddableChunks, search } from "../../search/engine";
import { matchLabel } from "../../search/hybrid-ranker";
import { renderableMatch } from "../../search/highlight";
import {
  clearModelCache,
  clearStore,
  clearTranscriptsForVideo,
  loadTranscriptForVideo,
  saveTranscript,
  storageUsage,
  type StorageUsage,
} from "../../storage/indexeddb";
import { parseStateChanged, type ContentRequest, type ContentResponse } from "../../types/messages";
import type { PageSnapshot, SearchResult, TranscriptDocument } from "../../types/transcript";
import { describeFailure, formatBytes, formatTime, timestampedLink } from "./format";

type SearchMode = "exact" | "meaning" | "ask";
type IconName =
  | "refresh"
  | "settings"
  | "search"
  | "close"
  | "play"
  | "spark"
  | "context"
  | "rewind"
  | "link"
  | "quote"
  | "shield";

const MEANING_DEBOUNCE_MS = 240;

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    refresh: <path d="M20 11a8.1 8.1 0 0 0-14.9-4M4 4v5h5M4 13a8.1 8.1 0 0 0 14.9 4M20 20v-5h-5" />,
    settings: (
      <>
        <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5" />
        <circle cx="16" cy="6" r="2" />
        <circle cx="8" cy="12" r="2" />
        <circle cx="13" cy="18" r="2" />
      </>
    ),
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    play: <path d="m9 7 8 5-8 5V7Z" />,
    spark: <path d="m12 3 1.2 4.1a5 5 0 0 0 3.7 3.7L21 12l-4.1 1.2a5 5 0 0 0-3.7 3.7L12 21l-1.2-4.1a5 5 0 0 0-3.7-3.7L3 12l4.1-1.2a5 5 0 0 0 3.7-3.7L12 3Z" />,
    context: <><path d="M5 6h14M5 12h10M5 18h7" /><path d="m16 16 3 3 3-3" /></>,
    rewind: <><path d="m11 7-5 5 5 5" /><path d="M18 8.5a6 6 0 1 1-8.8 8" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1" /></>,
    quote: <><path d="M8 11H4a5 5 0 0 1 5-5v9a4 4 0 0 1-4 4" /><path d="M19 11h-4a5 5 0 0 1 5-5v9a4 4 0 0 1-4 4" /></>,
    shield: <path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z" />,
  };
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

/** Renders text with highlight ranges as React nodes — never as HTML. */
function Highlighted({ text, ranges }: { text: string; ranges: Array<[number, number]> }) {
  if (!ranges.length) return <>{text}</>;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], index) => {
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(<mark key={`${start}-${index}`}>{text.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

async function activeYoutubeTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs.find((tab) => {
    if (!tab.url) return false;
    try {
      // Host check, not a substring check: "evil.example/?ref=youtube.com" is not YouTube.
      const host = new URL(tab.url).hostname;
      return host === "youtube.com" || host.endsWith(".youtube.com");
    } catch {
      return false;
    }
  });
}

function sendToTab(tabId: number, message: ContentRequest): Promise<ContentResponse> {
  return browser.tabs.sendMessage(tabId, message) as Promise<ContentResponse>;
}

export default function App() {
  const [tabId, setTabId] = useState<number>();
  const [snapshot, setSnapshot] = useState<PageSnapshot>({ status: "idle", generation: 0 });
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("exact");
  const [activeIndex, setActiveIndex] = useState(0);

  const [aiEnabled, setAiEnabled] = useState(false);
  const [askEnabled, setAskEnabled] = useState(false);
  const [modelStatus, setModelStatus] = useState<ModelStatus>({ phase: "idle", message: "" });
  const [semanticResults, setSemanticResults] = useState<SearchResult[]>([]);
  const [indexedTranscript, setIndexedTranscript] = useState<string>();
  const [busy, setBusy] = useState(false);

  const [answer, setAnswer] = useState<AskOutcome>();
  const [answering, setAnswering] = useState(false);
  const [expanded, setExpanded] = useState<string>();
  const [notice, setNotice] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [usage, setUsage] = useState<StorageUsage>();

  const client = useRef<SemanticSearchClient>(undefined);
  const searchAbort = useRef<AbortController>(undefined);
  const indexAbort = useRef<AbortController>(undefined);
  const askAbort = useRef<AbortController>(undefined);
  const tabRef = useRef<number>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  tabRef.current = tabId;
  const transcript: TranscriptDocument | undefined = snapshot.document;
  const transcriptId = transcript?.transcriptId;

  // Built once per transcript, not once per keystroke.
  const index = useMemo(
    () => (transcript ? buildRetrievalIndex(transcript.transcriptId, transcript.cues) : undefined),
    [transcript]
  );

  const results = useMemo(() => {
    if (!index) return [];
    return search(index, query, {
      mode: mode === "exact" ? "exact" : "meaning",
      semantic: semanticResults,
    });
  }, [index, mode, query, semanticResults]);

  useEffect(() => setActiveIndex(0), [query, mode]);

  const adoptSnapshot = useCallback(async (next: PageSnapshot, forTab: number | undefined) => {
    // A snapshot for a tab we are no longer looking at is stale by definition.
    if (forTab !== undefined && forTab !== tabRef.current) return;
    setSnapshot((current) => (next.generation < current.generation && next.videoId === current.videoId ? current : next));
    if (next.document) {
      void saveTranscript(next.document).catch(() => undefined);
    } else if ((next.status === "loading" || next.status === "failed") && next.videoId) {
      const cached = await loadTranscriptForVideo(next.videoId).catch(() => undefined);
      // Once a transcript has been captured for a video it stays usable, even when acquisition
      // later fails — YouTube withholding a caption body today must not lose what we already have.
      if (cached && tabRef.current === forTab) {
        setSnapshot((current) =>
          current.videoId === next.videoId && current.status !== "ready"
            ? { ...current, status: "ready", document: { ...cached.document, source: "cache" } }
            : current
        );
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    const tab = await activeYoutubeTab();
    if (!tab?.id) {
      setTabId(undefined);
      setSnapshot({ status: "idle", generation: 0 });
      return;
    }
    setTabId(tab.id);
    tabRef.current = tab.id;

    // The content script registers at document_idle, so a panel opened during page load can race
    // it. Retry briefly before concluding the tab is not connected at all.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await sendToTab(tab.id, { type: "recalltube:get-state" });
        if (response.ok && response.snapshot) await adoptSnapshot(response.snapshot, tab.id);
        return;
      } catch {
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }

    setSnapshot({
      status: "failed",
      generation: 0,
      reason: "tab-not-connected",
      diagnostics: [
        {
          adapter: "side-panel",
          outcome: "failed",
          detail: "No RecallTube content script answered in this tab after 3 attempts.",
          elapsedMs: 0,
        },
      ],
    });
  }, [adoptSnapshot]);

  useEffect(() => {
    void browser.storage.local.get(["aiEnabled", "askEnabled"]).then((stored) => {
      setAiEnabled(stored.aiEnabled === true);
      setAskEnabled(stored.askEnabled === true);
    });
    void refresh();

    const onMessage = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (sender.id && sender.id !== browser.runtime.id) return;
      const parsed = parseStateChanged(message);
      if (!parsed) return;
      void adoptSnapshot(parsed.snapshot, sender.tab?.id);
    };
    const onActivated = () => void refresh();
    const onUpdated = (updatedTabId: number, changes: { url?: string }) => {
      // Only react to the tab we are attached to, and only to URL changes — the alpha refreshed on
      // every update in every tab.
      if (updatedTabId === tabRef.current && changes.url) void refresh();
    };

    browser.runtime.onMessage.addListener(onMessage);
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);
    return () => {
      browser.runtime.onMessage.removeListener(onMessage);
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [adoptSnapshot, refresh]);

  // A new transcript invalidates every derived AI state.
  useEffect(() => {
    setSemanticResults([]);
    setIndexedTranscript(undefined);
    setAnswer(undefined);
    indexAbort.current?.abort();
    searchAbort.current?.abort();
  }, [transcriptId]);

  useEffect(() => () => client.current?.dispose(), []);

  // Index for meaning/ask once, per transcript.
  useEffect(() => {
    if (mode === "exact" || !aiEnabled || !index || !transcriptId) return;
    if (indexedTranscript === transcriptId) return;

    client.current ??= new SemanticSearchClient(setModelStatus);
    indexAbort.current?.abort();
    const controller = new AbortController();
    indexAbort.current = controller;
    setBusy(true);

    void client.current
      .index(
        {
          transcriptId,
          videoId: transcript?.video.id ?? "",
          modelKey: DEFAULT_MODEL_ID,
          preferredBackend: "webgpu",
          chunks: embeddableChunks(index),
        },
        controller.signal
      )
      .then(() => setIndexedTranscript(transcriptId))
      .catch((error: Error) => {
        if (error.name !== "AbortError") setModelStatus({ phase: "failed", message: error.message });
      })
      .finally(() => setBusy(false));
  }, [aiEnabled, index, indexedTranscript, mode, transcript?.video.id, transcriptId]);

  // Debounced semantic search, cancelling the previous one at the worker.
  useEffect(() => {
    if (mode === "exact" || !aiEnabled || indexedTranscript !== transcriptId || query.trim().length < 2) {
      setSemanticResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      searchAbort.current?.abort();
      const controller = new AbortController();
      searchAbort.current = controller;
      setBusy(true);
      void client.current
        ?.search(transcriptId!, query.trim(), 25, controller.signal)
        .then(setSemanticResults)
        .catch((error: Error) => {
          if (error.name !== "AbortError") setModelStatus({ phase: "failed", message: error.message });
        })
        .finally(() => setBusy(false));
    }, MEANING_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [aiEnabled, indexedTranscript, mode, query, transcriptId]);

  const seek = useCallback(
    async (seconds: number) => {
      if (!tabId) return;
      await sendToTab(tabId, { type: "recalltube:seek", seconds }).catch(() => undefined);
    },
    [tabId]
  );

  const toast = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 1_600);
  };

  const copyLink = async (seconds: number) => {
    if (!transcript) return;
    await navigator.clipboard.writeText(timestampedLink(transcript.video.id, seconds));
    toast(`Copied link at ${formatTime(seconds)}`);
  };

  const copyQuote = async (result: SearchResult) => {
    if (!transcript) return;
    const link = timestampedLink(transcript.video.id, result.start);
    await navigator.clipboard.writeText(`"${result.text}" — ${formatTime(result.start)}\n${link}`);
    toast("Copied quote");
  };

  const runAsk = async () => {
    if (!index || !transcript || query.trim().length < 3) return;
    askAbort.current?.abort();
    const controller = new AbortController();
    askAbort.current = controller;
    setAnswering(true);
    setAnswer(undefined);
    try {
      const outcome = await ask(query.trim(), results, transcript.cues, {
        allowPromptApi: askEnabled,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setAnswer(outcome);
    } finally {
      setAnswering(false);
    }
  };

  const reloadTab = async () => {
    if (!tabId) return;
    await browser.tabs.reload(tabId).catch(() => undefined);
    // The content script registers at document_idle; give the reload a head start before asking.
    window.setTimeout(() => void refresh(), 1_200);
  };

  const changeLanguage = async (languageCode: string) => {
    if (!tabId) return;
    setSnapshot((current) => ({ ...current, status: "loading" }));
    await sendToTab(tabId, { type: "recalltube:refresh", languageCode }).catch(() => undefined);
  };

  const openSettings = async () => {
    setShowSettings(true);
    setUsage(await storageUsage().catch(() => undefined));
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setQuery("");
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (mode === "ask") void runAsk();
      else if (results[activeIndex]) void seek(results[activeIndex]!.start);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => {
        const next = event.key === "ArrowDown" ? current + 1 : current - 1;
        return Math.max(0, Math.min(results.length - 1, next));
      });
    }
  };

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, results]);

  const enableAi = async () => {
    setAiEnabled(true);
    await browser.storage.local.set({ aiEnabled: true });
  };

  const disableAi = async () => {
    setAiEnabled(false);
    setIndexedTranscript(undefined);
    setSemanticResults([]);
    client.current?.dispose();
    client.current = undefined;
    setModelStatus({ phase: "idle", message: "" });
    await browser.storage.local.set({ aiEnabled: false });
  };

  const descriptor = modelDescriptor(DEFAULT_MODEL_ID);
  const tracks = transcript?.availableTracks ?? [];
  const backendLabel =
    modelStatus.backend === "webgpu" ? "WebGPU" : modelStatus.backend === "wasm" ? "CPU (WASM)" : undefined;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img className="brand-mark" src="/icons/icon-32.png" alt="" />
          <span className="brand-copy">
            <strong>RecallTube</strong>
            <small>Find the moment</small>
          </span>
        </div>
        <div className="topbar-actions">
          <button className="icon-button" onClick={() => void refresh()} title="Reload transcript" aria-label="Reload transcript">
            <Icon name="refresh" />
          </button>
          <button className="icon-button" onClick={() => void openSettings()} title="Privacy and storage" aria-label="Privacy and storage">
            <Icon name="settings" />
          </button>
        </div>
      </header>

      <div aria-live="polite" className="visually-hidden">
        {snapshot.status === "loading"
          ? "Reading captions"
          : transcript
            ? `${results.length} ${results.length === 1 ? "moment" : "moments"} found`
            : ""}
      </div>

      {!transcript ? (
        <EmptyState
          snapshot={snapshot}
          onRetry={() => void refresh()}
          onReloadTab={snapshot.reason === "tab-not-connected" ? () => void reloadTab() : undefined}
        />
      ) : (
        <>
          <section className="video-context">
            <div className="eyebrow"><span className="live-dot" aria-hidden="true" /> READY TO RECALL</div>
            <h1 title={transcript.video.title}>{transcript.video.title}</h1>
            <div className="metadata">
              <span>{transcript.cues.length.toLocaleString()} captions</span>
              {transcript.track && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{transcript.track.languageName}</span>
                </>
              )}
              {transcript.track?.kind === "asr" && <span className="pill auto">AUTO</span>}
              {transcript.track?.translatedFrom && <span className="pill translated">TRANSLATED</span>}
              {transcript.source === "dom" && <span className="pill">CAPTURED</span>}
              {transcript.source === "cache" && <span className="pill">SAVED</span>}
            </div>
            {tracks.length > 1 && (
              <label className="language-select">
                <span className="visually-hidden">Caption language</span>
                <select
                  value={transcript.track?.languageCode ?? ""}
                  onChange={(event) => void changeLanguage(event.target.value)}
                >
                  {tracks.map((track) => (
                    <option key={track.id} value={track.languageCode}>
                      {track.languageName}
                      {track.kind === "asr" ? " (auto)" : ""}
                      {track.translatedFrom ? " (translated)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </section>

          <section className="search-area">
            <div className="mode-tabs" role="tablist" aria-label="Search mode">
              {(["exact", "meaning", "ask"] as const).map((value) => (
                <button
                  key={value}
                  role="tab"
                  id={`tab-${value}`}
                  aria-selected={mode === value}
                  aria-controls="results-panel"
                  className={mode === value ? "active" : ""}
                  onClick={() => setMode(value)}
                >
                  {value === "exact" ? "Exact" : value === "meaning" ? "Meaning" : "Ask"}
                </button>
              ))}
            </div>
            <label className="search-box">
              <Icon name="search" size={19} />
              <input
                ref={inputRef}
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder={
                  mode === "exact"
                    ? "Search words or a phrase…"
                    : mode === "meaning"
                      ? "Describe what you remember…"
                      : "Ask a question about this video…"
                }
                aria-label="Search transcript"
                dir="auto"
              />
              {query && (
                <button onClick={() => setQuery("")} aria-label="Clear search">
                  <Icon name="close" size={16} />
                </button>
              )}
            </label>
            <p className="search-hint">
              {mode === "exact"
                ? "Finds phrases even when they are split across caption lines."
                : mode === "meaning"
                  ? "Finds paraphrases, and can search across languages."
                  : "Answers only from this transcript, with citations you can click."}
            </p>
          </section>

          {mode !== "exact" && !aiEnabled && (
            <section className="ai-consent">
              <h2>Turn on local meaning search</h2>
              <p>
                RecallTube downloads a {descriptor.approximateDownloadMb} MB multilingual model once from
                huggingface.co, then runs entirely on this device. Your transcript, your queries and the
                resulting vectors never leave the browser. Exact search never needs this.
              </p>
              <button className="primary-button" onClick={() => void enableAi()}>
                Download the model and enable
              </button>
            </section>
          )}

          {mode !== "exact" && aiEnabled && modelStatus.phase !== "idle" && (
            <section className="ai-status" aria-live="polite">
              <div className="ai-status-row">
                <span className={busy ? "pulse-dot" : "ready-dot"} aria-hidden="true" />
                <span>{modelStatus.message}</span>
                {backendLabel && <span className="pill">{backendLabel}</span>}
              </div>
              {modelStatus.progress !== undefined && busy && (
                <progress max={100} value={modelStatus.progress}>
                  {Math.round(modelStatus.progress)}%
                </progress>
              )}
              {modelStatus.phase === "indexing" && modelStatus.total ? (
                <span className="muted">
                  {modelStatus.indexed}/{modelStatus.total} passages
                </span>
              ) : null}
              {busy && (
                <button
                  className="text-button"
                  onClick={() => {
                    indexAbort.current?.abort();
                    searchAbort.current?.abort();
                    setBusy(false);
                  }}
                >
                  Cancel
                </button>
              )}
            </section>
          )}

          {mode === "ask" && (
            <section className="ask-area">
              <button className="primary-button" onClick={() => void runAsk()} disabled={answering || query.trim().length < 3}>
                {answering ? "Reading the transcript…" : "Answer from this video"}
              </button>
              {answer && (
                <div className="answer-card">
                  <p className="answer-text">{answer.answer}</p>
                  {!answer.generative && answer.status === "answered" && (
                    <p className="muted">
                      Showing the strongest passages verbatim, in the transcript&apos;s own words.
                      {promptApiLanguage(query.trim())
                        ? " On-device answer generation is not available in this browser."
                        : " Your browser's on-device model cannot write answers in this language."}
                    </p>
                  )}
                  <ul className="citations">
                    {answer.citations.map((citation) => {
                      const passage = answer.evidence.find((item) => item.id === citation.evidenceId);
                      return (
                        <li key={citation.evidenceId}>
                          <button className="citation" onClick={() => void seek(citation.start)}>
                            <span className="timestamp">{formatTime(citation.start)}</span>
                            <span dir="auto">{passage?.text}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </section>
          )}

          <section className="results-section" id="results-panel" role="tabpanel" aria-labelledby={`tab-${mode}`}>
            {query.trim().length < 2 ? (
              <div className="prompt-state">
                <p>Type what was said, or switch to Meaning and describe what you remember.</p>
              </div>
            ) : results.length ? (
              <>
                <div className="result-count">
                  <span>
                    {results.length} {results.length === 1 ? "moment" : "moments"}
                  </span>
                  {busy && <span className="muted">updating…</span>}
                </div>
                <div className="result-list" ref={listRef} role="listbox" aria-label="Search results">
                  {results.map((result, position) => (
                    <ResultCard
                      key={result.id}
                      result={result}
                      cues={transcript.cues}
                      active={position === activeIndex}
                      expanded={expanded === result.id}
                      languageName={transcript.track?.languageName}
                      onActivate={() => setActiveIndex(position)}
                      onSeek={() => void seek(result.start)}
                      onSeekEarlier={() => void seek(Math.max(0, result.start - 15))}
                      onCopyLink={() => void copyLink(result.start)}
                      onCopyQuote={() => void copyQuote(result)}
                      onToggleContext={() => setExpanded(expanded === result.id ? undefined : result.id)}
                    />
                  ))}
                </div>
              </>
            ) : (
              <div className="no-results">
                <h2>No moments found</h2>
                <p>
                  {mode === "exact"
                    ? "Try fewer words, or switch to Meaning to search by idea."
                    : busy
                      ? "The local model is still working…"
                      : "Try describing the idea differently."}
                </p>
              </div>
            )}
          </section>
        </>
      )}

      {showSettings && (
        <SettingsPanel
          tabId={tabId}
          usage={usage}
          aiEnabled={aiEnabled}
          askEnabled={askEnabled}
          videoId={transcript?.video.id}
          diagnostics={snapshot.diagnostics}
          onClose={() => setShowSettings(false)}
          onDisableAi={() => void disableAi()}
          onToggleAsk={async (value) => {
            setAskEnabled(value);
            await browser.storage.local.set({ askEnabled: value });
          }}
          onClear={async (target) => {
            if (target === "video" && transcript) await clearTranscriptsForVideo(transcript.video.id);
            else if (target === "transcripts") await clearStore("transcripts");
            else if (target === "embeddings") await clearStore("embeddings");
            else if (target === "model") await clearModelCache();
            setUsage(await storageUsage().catch(() => undefined));
            setIndexedTranscript(undefined);
            toast("Cleared");
          }}
        />
      )}

      {notice && <div className="toast">{notice}</div>}
      <footer>
        <span className="privacy-note"><Icon name="shield" size={13} /> Private by design</span>
        <span>Runs on this device</span>
      </footer>
    </div>
  );
}

function EmptyState({
  snapshot,
  onRetry,
  onReloadTab,
}: {
  snapshot: PageSnapshot;
  onRetry: () => void;
  /** Offered when the tab predates this extension build and has no content script. */
  onReloadTab?: () => void;
}) {
  const content =
    snapshot.status === "loading"
      ? { title: "Reading captions…", body: "RecallTube is loading this video's transcript." }
      : snapshot.status === "failed" && snapshot.reason
        ? describeFailure(snapshot.reason)
        : { title: "Open a YouTube video", body: "RecallTube searches the captions of the video in your active tab." };

  return (
    <main className="empty-state">
      <div className={`empty-visual${snapshot.status === "loading" ? " loading" : ""}`}>
        <img src="/icons/icon-128.png" alt="" />
        {snapshot.status === "loading" && <span className="orbit" aria-hidden="true" />}
      </div>
      <div className="empty-copy">
        <span className="eyebrow">SEARCH THE MOMENT, NOT THE WHOLE VIDEO</span>
        <h1>{content.title}</h1>
        <p>{content.body}</p>
      </div>
      {snapshot.status !== "loading" && (
        <div className="empty-actions">
          {onReloadTab && (
            <button className="primary-button" onClick={onReloadTab}>
              Reload this YouTube tab
            </button>
          )}
          <button className="secondary-button retry-button" onClick={onRetry}>
            <Icon name="refresh" size={16} />
            Try again
          </button>

        </div>
      )}
    </main>
  );
}

function ResultCard({
  result,
  cues,
  active,
  expanded,
  languageName,
  onActivate,
  onSeek,
  onSeekEarlier,
  onCopyLink,
  onCopyQuote,
  onToggleContext,
}: {
  result: SearchResult;
  cues: TranscriptDocument["cues"];
  active: boolean;
  expanded: boolean;
  languageName?: string;
  onActivate: () => void;
  onSeek: () => void;
  onSeekEarlier: () => void;
  onCopyLink: () => void;
  onCopyQuote: () => void;
  onToggleContext: () => void;
}) {
  const rendered = renderableMatch(result, cues);
  const label = matchLabel(result.signals);

  return (
    <article className={`result-card${active ? " active" : ""}`} data-active={active} role="option" aria-selected={active}>
      <button className="result-main" onClick={onSeek} onFocus={onActivate}>
        <span className="result-head">
          <span className="timestamp"><Icon name="play" size={13} />{formatTime(result.start)}</span>
          <span className="match-kind">{label}</span>
          {languageName && <span className="muted">{languageName}</span>}
        </span>
        <span className="result-text" dir="auto">
          <Highlighted text={rendered.text} ranges={rendered.ranges} />
        </span>
        {result.explanation && <span className="explanation">{result.explanation}</span>}
      </button>
      {expanded && (result.contextBefore || result.contextAfter) && (
        <p className="context" dir="auto">
          {result.contextBefore && <span className="muted">…{result.contextBefore} </span>}
          {result.contextAfter && <span className="muted"> {result.contextAfter}…</span>}
        </p>
      )}
      <div className="result-actions">
        <button onClick={onToggleContext} aria-label={expanded ? "Hide context" : "Show more context"}>
          <Icon name="context" size={14} />
          {expanded ? "Less" : "Context"}
        </button>
        <button onClick={onSeekEarlier} aria-label="Play from 15 seconds earlier">
          <Icon name="rewind" size={14} /> −15s
        </button>
        <button onClick={onCopyLink} aria-label={`Copy link at ${formatTime(result.start)}`}>
          <Icon name="link" size={14} />
          Link
        </button>
        <button onClick={onCopyQuote} aria-label="Copy quote with timestamp">
          <Icon name="quote" size={14} />
          Quote
        </button>
      </div>
    </article>
  );
}

function SettingsPanel({
  tabId,
  usage,
  aiEnabled,
  askEnabled,
  videoId,
  diagnostics,
  onClose,
  onDisableAi,
  onToggleAsk,
  onClear,
}: {
  /** Needed to pull live diagnostics from the page rather than the snapshot's stale copy. */
  tabId?: number;
  usage?: StorageUsage;
  aiEnabled: boolean;
  askEnabled: boolean;
  videoId?: string;
  diagnostics?: PageSnapshot["diagnostics"];
  onClose: () => void;
  onDisableAi: () => void;
  onToggleAsk: (value: boolean) => Promise<void>;
  onClear: (target: "video" | "transcripts" | "embeddings" | "model") => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);

  const copyDiagnostics = async () => {
    // Pull fresh diagnostics from the tab: the snapshot's copy predates later page activity.
    const live = tabId
      ? await sendToTab(tabId, { type: "recalltube:diagnostics" }).catch(() => undefined)
      : undefined;
    // Deliberately excludes transcript text — a diagnostics report is about adapters, not content.
    const report = {
      version: browser.runtime.getManifest().version,
      userAgent: navigator.userAgent,
      webgpu: "gpu" in navigator,
      adapters: (live && live.ok ? live.diagnostics : undefined) ?? diagnostics ?? [],
    };
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Privacy and storage">
      <div className="settings-panel">
        <header>
          <div>
            <span className="settings-kicker"><Icon name="shield" size={13} /> DEVICE-ONLY</span>
            <h2>Privacy &amp; storage</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings">
            <Icon name="close" />
          </button>
        </header>

        <p className="muted">
          Everything stays on this device. RecallTube has no server, no account and no analytics. The only network
          requests it makes are to YouTube for captions and, if you enable meaning search, to huggingface.co to
          download the model once.
        </p>

        {usage && (
          <dl className="usage">
            <div>
              <dt>Cached transcripts</dt>
              <dd>{usage.transcripts}</dd>
            </div>
            <div>
              <dt>Embedding sets</dt>
              <dd>{usage.embeddingRecords}</dd>
            </div>
            <div>
              <dt>Storage used</dt>
              <dd>{formatBytes(usage.usageBytes)}</dd>
            </div>
          </dl>
        )}

        <div className="settings-actions">
          {videoId && <button onClick={() => void onClear("video")}>Clear this video</button>}
          <button onClick={() => void onClear("transcripts")}>Clear all transcripts</button>
          <button onClick={() => void onClear("embeddings")}>Clear embeddings</button>
          <button onClick={() => void onClear("model")}>Delete downloaded model</button>
        </div>

        <label className="settings-toggle">
          <input type="checkbox" checked={askEnabled} onChange={(event) => void onToggleAsk(event.target.checked)} />
          <span>
            Use the browser&apos;s built-in on-device model for Ask answers when available. Without it, Ask shows the
            strongest passages verbatim instead of writing a summary.
          </span>
        </label>

        {aiEnabled && (
          <button className="secondary-button" onClick={onDisableAi}>
            Turn off meaning search
          </button>
        )}

        <button className="text-button" onClick={() => void copyDiagnostics()}>
          {copied ? "Diagnostics copied" : "Copy diagnostics (no transcript text)"}
        </button>
      </div>
    </div>
  );
}
