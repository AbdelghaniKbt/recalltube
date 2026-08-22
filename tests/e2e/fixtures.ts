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

export const ALL_FIXTURES = [ENGLISH_TALK, ASR_ROLLING, ARABIC_TALK, NO_CAPTIONS, CAPTIONS_FORBIDDEN, CAPTIONS_WITHHELD];

export function findFixture(videoId: string | null): VideoFixture | undefined {
  return ALL_FIXTURES.find((fixture) => fixture.id === videoId);
}

/**
 * A minimal stand-in for a YouTube watch page: a `<video>` element, a `#movie_player` exposing
 * `getPlayerResponse()`, and a `ytInitialPlayerResponse` global — the three things the bridge reads.
 */
export function watchPageHtml(fixture: VideoFixture): string {
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
    captions: fixture.tracks ? { playerCaptionsTracklistRenderer: { captionTracks } } : undefined,
  };

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${fixture.title} - YouTube</title></head>
<body>
  <div id="movie_player"><video class="html5-main-video" src=""></video></div>
  <script>
    window.ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};
    document.querySelector('#movie_player').getPlayerResponse = () => window.ytInitialPlayerResponse;
    // Mimic YouTube's SPA navigation so the content script's listeners are exercised.
    window.recallTubeNavigate = (videoId, response) => {
      window.ytInitialPlayerResponse = response;
      history.pushState({}, '', '/watch?v=' + videoId);
      window.dispatchEvent(new CustomEvent('yt-navigate-finish'));
    };
  </script>
</body></html>`;
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
