/**
 * Language selection for the browser's on-device Prompt API.
 *
 * Chrome requires a declared output language and currently supports only a small set. That set
 * excludes Arabic, which is a first-class RecallTube use case, so this module exists to make the
 * limitation explicit rather than to paper over it: when a question is in a language the API cannot
 * answer in, Ask falls back to the extractive provider.
 *
 * That fallback is not a consolation prize. Extractive answers return the transcript's own
 * sentences verbatim, in their original language — which is strictly more useful to an Arabic
 * speaker than a generated English summary of Arabic evidence would be.
 */

/** Output languages Chrome's Prompt API accepts. Widen only against the current specification. */
export const PROMPT_API_LANGUAGES = ["en", "de", "es", "fr", "ja"] as const;
export type PromptApiLanguage = (typeof PROMPT_API_LANGUAGES)[number];

const SCRIPTS: Array<{ pattern: RegExp; language: string }> = [
  { pattern: /\p{Script=Arabic}/u, language: "ar" },
  { pattern: /\p{Script=Hebrew}/u, language: "he" },
  { pattern: /\p{Script=Hiragana}|\p{Script=Katakana}/u, language: "ja" },
  { pattern: /\p{Script=Hangul}/u, language: "ko" },
  { pattern: /\p{Script=Cyrillic}/u, language: "ru" },
  { pattern: /\p{Script=Devanagari}/u, language: "hi" },
  { pattern: /\p{Script=Thai}/u, language: "th" },
  // Han without kana is far more likely Chinese than Japanese.
  { pattern: /\p{Script=Han}/u, language: "zh" },
];

/**
 * Function words that separate the Latin-script languages the Prompt API supports.
 *
 * This is a deliberate heuristic, not a language detector: it only has to be right often enough to
 * choose between five options, and being wrong costs a differently-worded answer rather than a
 * failure. Anything it cannot place becomes English.
 */
const LATIN_MARKERS: Array<{ language: PromptApiLanguage; words: readonly string[] }> = [
  { language: "fr", words: ["le", "la", "les", "des", "une", "dans", "pour", "que", "qui", "est", "pourquoi"] },
  { language: "es", words: ["el", "los", "las", "una", "para", "con", "por", "qué", "porque", "cómo", "dónde"] },
  { language: "de", words: ["der", "die", "das", "und", "ist", "nicht", "mit", "für", "ein", "warum", "wie"] },
  { language: "en", words: ["the", "and", "is", "of", "to", "in", "that", "what", "why", "how", "where", "did"] },
];

/** Best-effort primary language subtag for a short piece of text. */
export function detectLanguage(text: string): string {
  for (const { pattern, language } of SCRIPTS) {
    if (pattern.test(text)) return language;
  }

  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (!words.length) return "en";

  let best: { language: PromptApiLanguage; hits: number } = { language: "en", hits: 0 };
  for (const { language, words: markers } of LATIN_MARKERS) {
    const hits = words.filter((word) => markers.includes(word)).length;
    if (hits > best.hits) best = { language, hits };
  }
  return best.language;
}

/** The Prompt API language to request, or `undefined` when it cannot answer in this language. */
export function promptApiLanguage(text: string): PromptApiLanguage | undefined {
  const detected = detectLanguage(text);
  return (PROMPT_API_LANGUAGES as readonly string[]).includes(detected)
    ? (detected as PromptApiLanguage)
    : undefined;
}
