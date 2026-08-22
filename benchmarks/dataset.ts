import type { TranscriptCue } from "../src/types/transcript";

/**
 * RecallTube's retrieval benchmark dataset.
 *
 * Every transcript here is written for this benchmark. Nothing was captured from a user's session
 * and nothing contains personal data, so the whole dataset can be committed, diffed and reproduced.
 * That costs some realism, which the ASR fixture deliberately compensates for by reproducing the
 * error patterns (homophones, dropped punctuation, run-on cues) that real auto-captions exhibit.
 *
 * Labels are timestamp *ranges*, not chunk ids, so the same labels stay valid when chunking
 * changes — a benchmark that has to be relabelled whenever the system changes cannot detect
 * regressions.
 */

export interface TranscriptFixture {
  id: string;
  language: string;
  kind: "manual" | "asr";
  title: string;
  cues: TranscriptCue[];
}

export interface BenchmarkQuery {
  id: string;
  transcriptFixtureId: string;
  query: string;
  queryLanguage: string;
  /** Empty for queries that have no correct answer; the system should return nothing useful. */
  relevantTimeRanges: Array<{ start: number; end: number; relevance: number }>;
  category: string[];
}

function cues(lines: Array<[number, number, string]>): TranscriptCue[] {
  return lines.map(([start, end, text]) => ({ start, end, text }));
}

export const EN_TALK: TranscriptFixture = {
  id: "en-rag-talk",
  language: "en",
  kind: "manual",
  title: "Retrieval, fine-tuning, and what we actually shipped",
  cues: cues([
    [0, 5, "Welcome back. Today I want to talk about how we built search at Northwind."],
    [5, 10, "We spent about four months on this, and we got a lot of it wrong first."],
    [10, 15, "The first thing people asked was whether we should fine-tune a model."],
    [15, 21, "We started using machine"],
    [21, 26, "learning for anomaly detection, and that shaped how we thought about it."],
    [26, 32, "The reason I rejected fine-tuning is cost, plain and simple."],
    [32, 38, "Every time the documentation changed we would need another training run."],
    [38, 44, "Retrieval augmented generation just needs a fresh document in the index."],
    [44, 50, "So we do not fine-tune. I want to be very clear that we do not recommend it here."],
    [50, 56, "Let me give you a concrete example from a hospital we worked with."],
    [56, 62, "They indexed ten years of discharge summaries, roughly four million documents."],
    [62, 68, "Privacy mattered enormously, so everything stayed on premises."],
    [68, 74, "No patient data ever left their network. That was non-negotiable."],
    [74, 80, "The clinicians could ask a question and get the exact paragraph back."],
    [80, 86, "Now, about agents. People compare AI agents to employees, and I think that is wrong."],
    [86, 92, "An employee learns from a mistake. An agent repeats it until you change the prompt."],
    [92, 98, "We use RAG for the retrieval layer and a small model for the answer."],
    [98, 104, "Our latency budget was two hundred milliseconds end to end."],
    [104, 110, "We hit that using HNSW on about twelve million vectors."],
    [110, 116, "Later on we replaced HNSW with a flat index for the smaller tenants."],
    [116, 122, "The lesson is that brute force is fine until it really is not."],
    [122, 128, "Someone asked about GDPR. We treat every embedding as personal data."],
    [128, 134, "That decision cost us performance but it made the legal review trivial."],
    [134, 140, "Finally, evaluation. Do not trust a benchmark you did not build yourself."],
    [140, 146, "We wrote three hundred labelled queries before we changed a single ranker."],
  ]),
};

export const AR_TALK: TranscriptFixture = {
  id: "ar-privacy-talk",
  language: "ar",
  kind: "manual",
  title: "الذكاء الاصطناعي والخصوصية",
  cues: cues([
    [0, 6, "إِنَّ الذكاء الاصطناعي أصبح جزءا من حياتنا اليومية"],
    [6, 12, "لكن السؤال الأهم هو أين تذهب بياناتنا الشخصية"],
    [12, 18, "نحن نشغل النموذج على الجهاز مباشرة ولا نرسل أي شيء إلى الخادم"],
    [18, 24, "هذا يعني أن النصوص تبقى عندك أنت فقط"],
    [24, 30, "رفضت فكرة تدريب النموذج من جديد بسبب التكلفة العالية"],
    [30, 36, "الاسترجاع أسهل بكثير لأنك تضيف مستندا جديدا إلى الفهرس"],
    [36, 42, "في المستشفى الذي عملنا معه كانت الخصوصية هي الشرط الأول"],
    [42, 48, "عشر سنوات من التقارير الطبية بقيت داخل الشبكة المحلية"],
    [48, 54, "لم تخرج أي بيانات مريض إلى الإنترنت أبدا"],
    [54, 60, "أما بالنسبة للوكلاء الأذكياء فأنا لا أوافق على مقارنتهم بالموظفين"],
    [60, 66, "الموظف يتعلم من خطئه أما الوكيل فيكرر الخطأ حتى تغير التعليمات"],
    [66, 72, "استخدمنا نموذجا صغيرا للإجابة وطبقة استرجاع للبحث"],
    [72, 78, "وكان هدفنا أن يكون الرد أسرع من مئتي جزء من الثانية"],
  ]),
};

export const FR_TALK: TranscriptFixture = {
  id: "fr-ml-talk",
  language: "fr",
  kind: "manual",
  title: "Recherche sémantique et vie privée",
  cues: cues([
    [0, 6, "Bonjour à tous. Aujourd'hui je parle de recherche sémantique."],
    [6, 12, "La première question que l'on nous pose concerne le réglage fin des modèles."],
    [12, 18, "Nous avons refusé le réglage fin à cause du coût, tout simplement."],
    [18, 24, "Chaque mise à jour de la documentation demanderait un nouvel entraînement."],
    [24, 30, "La recherche augmentée n'a besoin que d'un document de plus dans l'index."],
    [30, 36, "Prenons l'exemple concret d'un hôpital avec lequel nous avons travaillé."],
    [36, 42, "Ils ont indexé dix ans de comptes rendus de sortie."],
    [42, 48, "La confidentialité était essentielle, donc tout restait sur place."],
    [48, 54, "Aucune donnée de patient n'a quitté leur réseau."],
    [54, 60, "Pour les agents, je trouve la comparaison avec des employés trompeuse."],
    [60, 66, "Un employé apprend de son erreur, un agent la répète."],
  ]),
};

/** Auto-generated captions: homophones, missing punctuation, and run-on cues. */
export const EN_ASR: TranscriptFixture = {
  id: "en-asr-talk",
  language: "en",
  kind: "asr",
  title: "auto captioned engineering talk",
  cues: cues([
    [0, 5, "so we started using machine learning about two years ago"],
    [5, 10, "and the first thing we tried was fine tuning a base model"],
    [10, 15, "that turned out to be really expensive so we dropped it"],
    [15, 20, "we moved to retrieval augmented generation instead"],
    [20, 25, "the hospital case is the one i always come back to"],
    [25, 30, "they had ten years of discharge summaries in there"],
    [30, 35, "privacy was the main thing so everything stayed on prem"],
    [35, 40, "know patient data left the building at all"],
    [40, 45, "for the vector index we used h and s w at first"],
    [45, 50, "then we swapped it for a flat index for small tenants"],
    [50, 55, "our latency budget was two hundred milliseconds"],
    [55, 60, "and we treat every embedding as personal data under g d p r"],
  ]),
};

export const FIXTURES: TranscriptFixture[] = [EN_TALK, AR_TALK, FR_TALK, EN_ASR];

export const QUERIES: BenchmarkQuery[] = [
  // --- Exact remembered quotes -------------------------------------------------------------
  {
    id: "q-exact-1",
    transcriptFixtureId: "en-rag-talk",
    query: "brute force is fine until it really is not",
    queryLanguage: "en",
    relevantTimeRanges: [{ start: 116, end: 122, relevance: 3 }],
    category: ["exact"],
  },
  {
    id: "q-exact-2",
    transcriptFixtureId: "en-rag-talk",
    query: "three hundred labelled queries",
    queryLanguage: "en",
    relevantTimeRanges: [{ start: 140, end: 146, relevance: 3 }],
    category: ["exact", "short"],
  },
  // --- Quotes split across cues ------------------------------------------------------------
  {
    id: "q-boundary-1",
    transcriptFixtureId: "en-rag-talk",
    query: "we started using machine learning for anomaly detection",
    queryLanguage: "en",
    relevantTimeRanges: [{ start: 15, end: 26, relevance: 3 }],
    category: ["boundary", "exact"],
  },
  // --- Paraphrased memories ----------------------------------------------------------------
  {
    id: "q-para-1",
    transcriptFixtureId: "en-rag-talk",
    query: "why did the speaker decide against training the model further",
    queryLanguage: "en",
    relevantTimeRanges: [
      { start: 26, end: 38, relevance: 3 },
      { start: 44, end: 50, relevance: 2 },
    ],
    category: ["paraphrase"],
  },
  {
    id: "q-para-2",
    transcriptFixtureId: "en-rag-talk",
    query: "the medical records example he promised earlier",
    queryLanguage: "en",
    relevantTimeRanges: [{ start: 50, end: 68, relevance: 3 }],
    category: ["paraphrase"],
  },
  {
    id: "q-para-3",
    transcriptFixtureId: "en-rag-talk",
    query: "he disagreed with treating software agents like staff",
    queryLanguage: "en",
    relevantTimeRanges: [{ start: 80, end: 92, relevance: 3 }],
    category: ["paraphrase", "negation"],
  },
  // --- Vague conceptual memories -----------------------------------------------------------
  {
    id: "q-vague-1",
    transcriptFixtureId: "en-rag-talk",
    query: "something about keeping data inside the building",
    queryLanguage: "en",
    relevantTimeRanges: [{ start: 62, end: 74, relevance: 3 }],
    category: ["vague"],
  },
  {
    id: "q-vague-2",
    transcriptFixtureId: "en-rag-talk",
    query: "the part where he talks about how fast it had to be",
    queryLanguage: "en",
    relevantTimeRanges: [{ start: 98, end: 110, relevance: 3 }],
    category: ["vague"],
  },
  // --- Misspellings and caption errors -----------------------------------------------------
  {
    id: "q-typo-1",
    transcriptFixtureId: "en-rag-talk",
    query: "retreival augmentd generaton",
    queryLanguage: "en",
    relevantTimeRanges: [{ start: 38, end: 44, relevance: 3 }],
    category: ["misspelling"],
  },
  {
    id: "q-typo-2",
    transcriptFixtureId: "en-rag-talk",
    query: "discharg summarys",
    queryLanguage: "en",
    relevantTimeRanges: [{ start: 56, end: 62, relevance: 3 }],
    category: ["misspelling"],
  },
  {
    id: "q-asr-1",
    transcriptFixtureId: "en-asr-talk",
    query: "no patient data left the building",
    queryLanguage: "en",
    relevantTimeRanges: [{ start: 35, end: 40, relevance: 3 }],
    category: ["asr-error", "homophone"],
  },
  {
    id: "q-asr-2",
    transcriptFixtureId: "en-asr-talk",
    query: "HNSW vector index",
    queryLanguage: "en",
    relevantTimeRanges: [{ start: 40, end: 45, relevance: 3 }],
    category: ["asr-error", "acronym"],
  },
  {
    id: "q-asr-3",
    transcriptFixtureId: "en-asr-talk",
    query: "GDPR and embeddings",
    queryLanguage: "en",
    relevantTimeRanges: [{ start: 55, end: 60, relevance: 3 }],
    category: ["asr-error", "acronym"],
  },
  {
    id: "q-nopunct-1",
    transcriptFixtureId: "en-rag-talk",
    query: "every time the documentation changed we would need another training run",
    queryLanguage: "en",
    relevantTimeRanges: [{ start: 32, end: 38, relevance: 3 }],
    category: ["missing-punctuation", "exact"],
  },
  // --- Named entities ----------------------------------------------------------------------
  {
    id: "q-entity-1",
    transcriptFixtureId: "en-rag-talk",
    query: "Northwind",
    queryLanguage: "en",
    relevantTimeRanges: [{ start: 0, end: 5, relevance: 3 }],
    category: ["named-entity", "short"],
  },
  // --- Repeated topics at different timestamps ---------------------------------------------
  {
    id: "q-repeat-1",
    transcriptFixtureId: "en-rag-talk",
    query: "HNSW",
    queryLanguage: "en",
    relevantTimeRanges: [
      { start: 104, end: 110, relevance: 3 },
      { start: 110, end: 116, relevance: 3 },
    ],
    category: ["repeated", "acronym", "short"],
  },
  {
    id: "q-repeat-2",
    transcriptFixtureId: "en-rag-talk",
    query: "fine-tuning",
    queryLanguage: "en",
    relevantTimeRanges: [
      { start: 10, end: 15, relevance: 2 },
      { start: 26, end: 32, relevance: 3 },
      { start: 44, end: 50, relevance: 3 },
    ],
    category: ["repeated"],
  },
  // --- Long natural-language questions -----------------------------------------------------
  {
    id: "q-long-1",
    transcriptFixtureId: "en-rag-talk",
    query:
      "what exactly did the speaker say about whether embeddings count as personal information for compliance purposes",
    queryLanguage: "en",
    relevantTimeRanges: [{ start: 122, end: 134, relevance: 3 }],
    category: ["long-question"],
  },
  // --- No relevant answer ------------------------------------------------------------------
  {
    id: "q-none-1",
    transcriptFixtureId: "en-rag-talk",
    query: "what is the capital city of Peru",
    queryLanguage: "en",
    relevantTimeRanges: [],
    category: ["no-answer"],
  },
  {
    id: "q-none-2",
    transcriptFixtureId: "ar-privacy-talk",
    query: "وصفة الكيك بالشوكولاتة",
    queryLanguage: "ar",
    relevantTimeRanges: [],
    category: ["no-answer"],
  },
  // --- Arabic over Arabic ------------------------------------------------------------------
  {
    id: "q-ar-1",
    transcriptFixtureId: "ar-privacy-talk",
    query: "ان الذكاء الاصطناعي",
    queryLanguage: "ar",
    relevantTimeRanges: [{ start: 0, end: 6, relevance: 3 }],
    category: ["arabic", "exact", "normalization"],
  },
  {
    id: "q-ar-2",
    transcriptFixtureId: "ar-privacy-talk",
    query: "لماذا رفض إعادة تدريب النموذج",
    queryLanguage: "ar",
    relevantTimeRanges: [{ start: 24, end: 36, relevance: 3 }],
    category: ["arabic", "paraphrase"],
  },
  {
    id: "q-ar-3",
    transcriptFixtureId: "ar-privacy-talk",
    query: "البيانات الطبية داخل الشبكة",
    queryLanguage: "ar",
    relevantTimeRanges: [{ start: 36, end: 54, relevance: 3 }],
    category: ["arabic", "paraphrase"],
  },
  // --- Cross-language ----------------------------------------------------------------------
  {
    id: "q-x-en-ar-1",
    transcriptFixtureId: "ar-privacy-talk",
    query: "the model runs on the device and nothing is sent to a server",
    queryLanguage: "en",
    relevantTimeRanges: [{ start: 12, end: 24, relevance: 3 }],
    category: ["cross-language", "en-over-ar"],
  },
  {
    id: "q-x-en-ar-2",
    transcriptFixtureId: "ar-privacy-talk",
    query: "comparing agents to employees",
    queryLanguage: "en",
    relevantTimeRanges: [{ start: 54, end: 66, relevance: 3 }],
    category: ["cross-language", "en-over-ar"],
  },
  {
    id: "q-x-ar-en-1",
    transcriptFixtureId: "en-rag-talk",
    query: "الخصوصية والبيانات الطبية",
    queryLanguage: "ar",
    relevantTimeRanges: [{ start: 56, end: 74, relevance: 3 }],
    category: ["cross-language", "ar-over-en"],
  },
  {
    id: "q-x-ar-en-2",
    transcriptFixtureId: "en-rag-talk",
    query: "لماذا رفض الضبط الدقيق للنموذج",
    queryLanguage: "ar",
    relevantTimeRanges: [{ start: 26, end: 38, relevance: 3 }],
    category: ["cross-language", "ar-over-en"],
  },
  {
    id: "q-x-fr-en-1",
    transcriptFixtureId: "fr-ml-talk",
    query: "why did they reject fine tuning",
    queryLanguage: "en",
    relevantTimeRanges: [{ start: 12, end: 24, relevance: 3 }],
    category: ["cross-language", "en-over-fr"],
  },
  {
    id: "q-x-fr-en-2",
    transcriptFixtureId: "fr-ml-talk",
    query: "hospital discharge summaries example",
    queryLanguage: "en",
    relevantTimeRanges: [{ start: 30, end: 42, relevance: 3 }],
    category: ["cross-language", "en-over-fr"],
  },
  {
    id: "q-x-en-fr-1",
    transcriptFixtureId: "en-rag-talk",
    query: "la confidentialité des données médicales",
    queryLanguage: "fr",
    relevantTimeRanges: [{ start: 56, end: 74, relevance: 3 }],
    category: ["cross-language", "fr-over-en"],
  },
  // --- Mixed-language query ----------------------------------------------------------------
  {
    id: "q-mixed-1",
    transcriptFixtureId: "ar-privacy-talk",
    query: "latency مئتي millisecond",
    queryLanguage: "mixed",
    relevantTimeRanges: [{ start: 72, end: 78, relevance: 3 }],
    category: ["mixed-language"],
  },
];
