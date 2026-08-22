import type { SearchResult, TranscriptCue } from "../types/transcript";
import { ExtractiveAnswerProvider } from "./extractive";
import { PromptApiAnswerProvider } from "./prompt-api";
import { promptApiLanguage } from "./language";
import type { EvidencePassage, GroundedAnswer, GroundedAnswerProvider } from "./types";

export * from "./types";
export { ExtractiveAnswerProvider } from "./extractive";
export { PromptApiAnswerProvider } from "./prompt-api";
export { detectLanguage, promptApiLanguage, PROMPT_API_LANGUAGES } from "./language";
export { validateAnswer, extractJsonObject } from "./validate";
export { SYSTEM_INSTRUCTION, buildUserPrompt, sanitizeEvidenceText } from "./prompt";

/** How many retrieved passages become evidence. Enough to answer; small enough to stay grounded. */
const MAX_EVIDENCE = 6;
/** Cues of context added around each passage so an answer is not built from a clipped sentence. */
const CONTEXT_CUES = 1;

/**
 * Turns retrieval results into evidence passages.
 *
 * Retrieval always runs first: the generative step never sees the transcript, only the passages
 * that retrieval selected. That is both a grounding property and a prompt-injection containment
 * measure — a hostile caption elsewhere in the video is not in the prompt at all.
 */
export function toEvidence(results: SearchResult[], cues: TranscriptCue[]): EvidencePassage[] {
  return results.slice(0, MAX_EVIDENCE).map((result, position) => {
    const first = Math.max(0, result.cueStartIndex - CONTEXT_CUES);
    const last = Math.min(cues.length - 1, result.cueEndIndex + CONTEXT_CUES);
    const slice = cues.slice(first, last + 1);
    return {
      id: `e${position + 1}`,
      start: slice[0]?.start ?? result.start,
      end: slice.at(-1)?.end ?? result.end,
      text: slice.map((cue) => cue.text).join(" "),
    };
  });
}

/**
 * Returns the best available provider for this question.
 *
 * Chrome's Prompt API only answers in a handful of languages. Rather than generating an English
 * summary of, say, Arabic evidence, questions in an unsupported language go to the extractive
 * provider — which returns the transcript's own sentences, in their own language. That is the more
 * useful answer, not a degraded one.
 */
export async function selectAnswerProvider(
  allowPromptApi: boolean,
  question = ""
): Promise<{ provider: GroundedAnswerProvider; generative: boolean }> {
  const language = promptApiLanguage(question);
  if (allowPromptApi && language) {
    const promptApi = new PromptApiAnswerProvider(language);
    if ((await promptApi.availability()) === "available") return { provider: promptApi, generative: true };
  }
  return { provider: new ExtractiveAnswerProvider(), generative: false };
}

export interface AskOutcome extends GroundedAnswer {
  evidence: EvidencePassage[];
  generative: boolean;
}

export async function ask(
  question: string,
  results: SearchResult[],
  cues: TranscriptCue[],
  options: { allowPromptApi: boolean; signal?: AbortSignal }
): Promise<AskOutcome> {
  const evidence = toEvidence(results, cues);
  const { provider, generative } = await selectAnswerProvider(options.allowPromptApi, question);
  const answer = await provider.answer({ question, evidence }, options.signal);
  return { ...answer, evidence, generative };
}
