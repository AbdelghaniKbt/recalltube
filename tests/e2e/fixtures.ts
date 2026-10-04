/**
 * Deterministic YouTube fixtures.
 *
 * These are hand-written, not captured from a real session: they carry no personal data, no
 * signed URLs and no session identifiers, and they can be committed and diffed safely.
 */

export interface VideoFixture {
  id: string;
  title: string;
  /** `undefined` models a video with captions disabled. */
  tracks?: Array<{ lang: string; name: string; kind?: "asr"; tlang?: string }>;
  json3?: Record<string, unknown>;
  /** When set, the timedtext endpoint responds with this status instead of a body. */
  status?: number;
  /** When set, the endpoint answers 200 with a zero-length body, as YouTube does in practice. */
  emptyBody?: boolean;
  /** Optional rows exposed only after YouTube's native transcript control is clicked. */
  nativeRows?: Array<{ timestamp: string; text: string }>;
  /** The player's `playabilityStatus`, for removed, private and unstarted videos. */
  playability?: { status: string; reason?: string };
  /**
   * A transcript panel that already holds a previous video's rows when the page loads, as YouTube's
   * does after an SPA navigation, with scripted behaviour after each click on the control.
   */
  prepopulatedPanel?: "fresh-after-request" | "stale-forever" | "closed-then-fresh";
}

function event(startMs: number, durationMs: number, text: string) {
  return { tStartMs: startMs, dDurationMs: durationMs, segs: [{ utf8: text }] };
}

export const ENGLISH_TALK: VideoFixture = {
  id: "rag00000001",
  title: "Why we chose retrieval over fine-tuning",
  tracks: [
    { lang: "en", name: "English" },
    { lang: "ar", name: "Arabic" },
    { lang: "fr", name: "French (auto-translated)", tlang: "fr" },
  ],
  json3: {
    events: [
      event(0, 4000, "Welcome back to the show."),
      event(4000, 5000, "Today we are talking about retrieval augmented generation."),
      event(9000, 5000, "The reason I rejected fine-tuning is cost."),
      event(14000, 5000, "Fine-tuning needs a new training run for every update."),
      event(19000, 5000, "Retrieval just needs a fresh document in the index."),
      event(24000, 5000, "Later I will give a concrete example from a hospital."),
      event(29000, 5000, "They indexed ten years of discharge summaries."),
      event(34000, 6000, "Privacy mattered, so everything stayed on premises."),
    ],
  },
};

/** Auto-generated captions, with the rolling-window duplication YouTube actually emits. */
export const ASR_ROLLING: VideoFixture = {
  id: "asr000000001",
  title: "Auto-captioned lecture",
  tracks: [{ lang: "en", name: "English (auto-generated)", kind: "asr" }],
  json3: {
    events: [
      event(0, 2000, "we started using"),
      event(1500, 2000, "we started using machine"),
      { tStartMs: 2000, dDurationMs: 500, aAppend: 1, segs: [{ utf8: "\n" }] },
      event(3000, 2000, "machine learning today"),
      event(5000, 2000, "machine learning today for anomaly"),
      event(7000, 3000, "for anomaly detection in production"),
    ],
  },
};

export const ARABIC_TALK: VideoFixture = {
  id: "ara000000001",
  title: "الذكاء الاصطناعي والخصوصية",
  tracks: [{ lang: "ar", name: "Arabic" }],
  json3: {
    events: [
      event(0, 5000, "إِنَّ الذكاء الاصطناعي مهم جدا اليوم"),
      event(5000, 5000, "لكن الخصوصية تبقى المشكلة الأكبر"),
      event(10000, 5000, "نحن نشغل النموذج على الجهاز مباشرة"),
      event(15000, 5000, "ولا نرسل أي بيانات إلى الخادم"),
    ],
  },
};

export const NO_CAPTIONS: VideoFixture = {
  id: "nocap0000001",
  title: "A video with captions disabled",
  tracks: [],
};

/** Valid 11-character IDs used by the playlist-navigation fixture. */
export const PLAYLIST_SECOND: VideoFixture = {
  ...ASR_ROLLING,
  id: "plvid000002",
  title: "Playlist anomaly-detection lecture",
};

export const PLAYLIST_NO_CAPTIONS: VideoFixture = {
  ...NO_CAPTIONS,
  id: "plnone00003",
  title: "Playlist video without captions",
};

export const PLAYLIST_NATIVE: VideoFixture = {
  id: "plnative003",
  title: "Playlist native-panel fallback",
  tracks: [{ lang: "en", name: "English" }],
  emptyBody: true,
  nativeRows: [
    { timestamp: "0:07", text: "Native playlist fallback captured this evidence." },
    { timestamp: "0:15", text: "The panel closes after the transcript is indexed." },
  ],
};

/**
 * The failure reported from the first live test: YouTube advertises an English track, then answers
 * the timed-text request with HTTP 200 and a zero-length body.
 */
export const CAPTIONS_WITHHELD: VideoFixture = {
  id: "withheld0001",
  title: "A video whose captions YouTube withholds",
  tracks: [{ lang: "en", name: "English" }],
  emptyBody: true,
};

export const CAPTIONS_FORBIDDEN: VideoFixture = {
  id: "forbid000001",
  title: "A video whose caption endpoint refuses",
  tracks: [{ lang: "en", name: "English" }],
  status: 403,
};

/** A removed video: no tracks, and the player itself says so. There is nothing to wait for. */
export const UNAVAILABLE: VideoFixture = {
  id: "gone00000001",
  title: "Video unavailable",
  tracks: undefined,
  playability: { status: "ERROR", reason: "Video unavailable" },
};

/** Stale rows at load; YouTube's request replaces them with fresh rows 1.2 s after the open. */
export const STALE_THEN_FRESH: VideoFixture = {
  id: "stalefresh01",
  title: "A video whose panel still shows the previous video's rows",
  tracks: [{ lang: "en", name: "English" }],
  emptyBody: true,
  prepopulatedPanel: "fresh-after-request",
};

/** Stale rows at load that are never replaced, and YouTube never fetches a transcript. */
export const STALE_FOREVER: VideoFixture = {
  id: "staleever001",
  title: "A video whose panel never leaves the previous video's rows",
  tracks: [{ lang: "en", name: "English" }],
  emptyBody: true,
  prepopulatedPanel: "stale-forever",
};

/** The first open is closed by the page before any rows arrive; the second gets fresh rows. */
export const CLOSED_THEN_FRESH: VideoFixture = {
  id: "closedfresh1",
  title: "A video whose panel is closed by navigation completion",
  tracks: [{ lang: "en", name: "English" }],
  emptyBody: true,
  prepopulatedPanel: "closed-then-fresh",
};

export const ALL_FIXTURES = [
  UNAVAILABLE,
  STALE_THEN_FRESH,
  STALE_FOREVER,
  CLOSED_THEN_FRESH,
  ENGLISH_TALK,
  ASR_ROLLING,
  ARABIC_TALK,
  NO_CAPTIONS,
  PLAYLIST_SECOND,
  PLAYLIST_NO_CAPTIONS,
  PLAYLIST_NATIVE,
  CAPTIONS_FORBIDDEN,
  CAPTIONS_WITHHELD,
];

export function findFixture(videoId: string | null): VideoFixture | undefined {
  return ALL_FIXTURES.find((fixture) => fixture.id === videoId);
}

/**
 * A minimal stand-in for a YouTube watch page: a `<video>` element, a `#movie_player` exposing
 * `getPlayerResponse()`, and a `ytInitialPlayerResponse` global — the three things the bridge reads.
 */
export function watchPageHtml(fixture: VideoFixture, playlist: VideoFixture[] = []): string {
  const captionTracks = (fixture.tracks ?? []).map((track) => ({
    baseUrl: `https://www.youtube.com/api/timedtext?v=${fixture.id}&lang=${track.lang}${
      track.tlang ? `&tlang=${track.tlang}` : ""
    }`,
    languageCode: track.tlang ?? track.lang,
    kind: track.kind,
    isTranslatable: true,
    name: { simpleText: track.name },
  }));

  const playerResponse = {
    videoDetails: { videoId: fixture.id, title: fixture.title },
    playabilityStatus: fixture.playability ?? { status: "OK" },
    captions: fixture.tracks ? { playerCaptionsTracklistRenderer: { captionTracks } } : undefined,
  };

  const playlistRows = playlist.map((item, position) => ({
    playlistPanelVideoRenderer: {
      videoId: item.id,
      title: { simpleText: item.title },
      index: { simpleText: String(position + 1) },
    },
  }));
  const playlistDom = playlist.map((item, position) => `
    <ytd-playlist-panel-video-renderer>
      <span id="index">${position + 1}</span>
      <a id="video-title" title="${item.title.replaceAll('"', '&quot;')}" href="/watch?v=${item.id}&list=PLrecalltube0001"></a>
    </ytd-playlist-panel-video-renderer>`).join("");
  const nativePanelDom = fixture.nativeRows?.length
    ? `<ytd-video-description-transcript-section-renderer>
        <button aria-controls="engagement-panel-searchable-transcript">Show transcript</button>
      </ytd-video-description-transcript-section-renderer>
      <ytd-engagement-panel-section-list-renderer
        target-id="engagement-panel-searchable-transcript"
        visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"></ytd-engagement-panel-section-list-renderer>`
    : "";
  const nativePanelScript = fixture.nativeRows?.length
    ? `
      document.querySelector('[aria-controls="engagement-panel-searchable-transcript"]').addEventListener('click', () => {
        const panel = document.querySelector('[target-id="engagement-panel-searchable-transcript"]');
        panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
        panel.innerHTML = '<button id="close-button" aria-label="Close transcript">Close</button>' + ${JSON.stringify(
          fixture.nativeRows
            .map(
              (row) =>
                `<ytd-transcript-segment-renderer><span class="segment-timestamp">${row.timestamp}</span><span class="segment-text">${row.text}</span></ytd-transcript-segment-renderer>`
            )
            .join("")
        )};
        panel.querySelector('#close-button').addEventListener('click', () => {
          panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
          panel.replaceChildren();
        });
      });`
    : "";

  // Present from the first paint, before the content script runs: that is when a real page's
  // previous-video rows exist, and the attempt under test is the automatic first one.
  const prepopulatedScript = fixture.prepopulatedPanel
    ? `<script>
    (() => {
      const mode = ${JSON.stringify(fixture.prepopulatedPanel)};
      window.nativeOpens = 0;
      const rows = (prefix, count) => Array.from({ length: count }, (_, i) =>
        '<ytd-transcript-segment-renderer><span class="segment-timestamp">0:0' + (i + 1) + '</span><span class="segment-text">' + prefix + ' ' + (i + 1) + '</span></ytd-transcript-segment-renderer>').join('');
      const close = '<button id="close-button" aria-label="Close transcript">Close</button>';
      const section = document.createElement('ytd-video-description-transcript-section-renderer');
      section.innerHTML = '<button aria-controls="engagement-panel-searchable-transcript">Show transcript</button>';
      const native = document.createElement('ytd-engagement-panel-section-list-renderer');
      native.setAttribute('target-id', 'engagement-panel-searchable-transcript');
      native.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
      const hide = () => native.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
      const render = (html) => { native.innerHTML = close + html; native.querySelector('#close-button').addEventListener('click', hide); };
      render(rows('stale', 2));
      const fresh = async () => {
        await fetch('https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false', { method: 'POST', body: '{}' }).catch(() => undefined);
        render(rows('fresh', 3));
      };
      section.querySelector('button').addEventListener('click', () => {
        window.nativeOpens += 1;
        native.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
        if (mode === 'fresh-after-request') setTimeout(() => void fresh(), 1200);
        if (mode === 'closed-then-fresh') {
          if (window.nativeOpens === 1) setTimeout(hide, 300);
          else setTimeout(() => void fresh(), 500);
        }
      });
      document.body.append(section, native);
    })();
  </script>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${fixture.title} - YouTube</title></head>
<body>
  <div id="movie_player"><video class="html5-main-video" src=""></video></div>
  ${nativePanelDom}
  ${prepopulatedScript}
  ${playlist.length ? `<ytd-playlist-panel-renderer><div id="title">RecallTube fixture playlist</div><div id="items">${playlistDom}</div></ytd-playlist-panel-renderer>` : ""}
  <script>
    window.ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};
    window.ytInitialData = ${JSON.stringify(playlist.length ? {
      playlistTitle: { simpleText: "RecallTube fixture playlist" },
      numVideosText: { simpleText: `${playlist.length} videos` },
      contents: playlistRows,
    } : {})};
    document.querySelector('#movie_player').getPlayerResponse = () => window.ytInitialPlayerResponse;
    // Mimic YouTube's SPA navigation, in the order its events fire live (measured 2026-10-03:
    // navigate-start, player-updated, navigate-finish, page-data-updated), so the content
    // script's listeners are exercised.
    window.recallTubeNavigate = (videoId, response) => {
      window.dispatchEvent(new CustomEvent('yt-navigate-start'));
      window.ytInitialPlayerResponse = response;
      history.pushState({}, '', '/watch?v=' + videoId);
      window.dispatchEvent(new CustomEvent('yt-player-updated'));
      window.dispatchEvent(new CustomEvent('yt-navigate-finish'));
      window.dispatchEvent(new CustomEvent('yt-page-data-updated'));
    };
    ${nativePanelScript}
  </script>
</body></html>`;
}

export function playlistPageHtml(playlist: VideoFixture[]): string {
  return watchPageHtml(playlist[0] ?? ENGLISH_TALK, playlist).replace("<div id=\"movie_player\"><video class=\"html5-main-video\" src=\"\"></video></div>", "");
}

export function playerResponseFor(fixture: VideoFixture): unknown {
  const captionTracks = (fixture.tracks ?? []).map((track) => ({
    baseUrl: `https://www.youtube.com/api/timedtext?v=${fixture.id}&lang=${track.lang}${
      track.tlang ? `&tlang=${track.tlang}` : ""
    }`,
    languageCode: track.tlang ?? track.lang,
    kind: track.kind,
    isTranslatable: true,
    name: { simpleText: track.name },
  }));
  return {
    videoDetails: { videoId: fixture.id, title: fixture.title },
    captions: fixture.tracks ? { playerCaptionsTracklistRenderer: { captionTracks } } : undefined,
  };
}
