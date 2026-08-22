import { characterNgrams, tokenize } from "../transcript/normalize";
import { scorePassage, termWeights } from "../search/token-match";
import type { GroundedAnswer, GroundedAnswerProvider, GroundedAnswerRequest } from "./types";
import { INSUFFICIENT_EVIDENCE_MESSAGE } from "./types";

/**
 * The always-available Ask provider.
 *
 * It generates nothing. It ranks the supplied evidence against the question and returns the
 * strongest passages verbatim, cited. That is deliberately less satisfying than a prose answer,
 * but it cannot fabricate, it works offline with no model, and it keeps Ask useful on every
 * device — which is what stops the feature from being gated behind a browser API most users do
 * not have.
 */

/**
 * A passage must contain a query term at least this distinctive to be offered as an answer.
 *
 * Gating on the single most distinctive matched term rather than on overall coverage is what stops
 * "what is the capital of Peru?" from matching an unrelated passage on "the" and "is" alone. Fuzzy
 * n-gram overlap deliberately cannot get a passage past this gate — it only orders passages that
 * already qualify — because character overlap between unrelated English sentences is high enough
 * to admit almost anything.
 */
const MIN_EVIDENCE = 0.8;
const MAX_PASSAGES = 3;

export class ExtractiveAnswerProvider implements GroundedAnswerProvider {
  readonly id = "extractive";

  async availability() {
    return "available" as const;
  }

  async answer(request: GroundedAnswerRequest): Promise<GroundedAnswer> {
    const queryTokens = new Set(tokenize(request.question));
    const queryNgrams = characterNgrams(request.question);
    const weights = termWeights(
      request.evidence.map((passage) => passage.text),
      queryTokens
    );

    const ranked = request.evidence
      .map((passage) => ({ passage, ...scorePassage(passage.text, queryTokens, queryNgrams, weights) }))
      .filter((entry) => entry.evidence >= MIN_EVIDENCE)
      .sort((left, right) => right.ranking - left.ranking)
      .slice(0, MAX_PASSAGES);

    if (!ranked.length) {
      return {
        answer: INSUFFICIENT_EVIDENCE_MESSAGE,
        citations: [],
        status: "insufficient-evidence",
        providerId: this.id,
      };
    }

    return {
      answer: "Here is what the transcript says about that:",
      citations: ranked
        .sort((left, right) => left.passage.start - right.passage.start)
        .map(({ passage }) => ({ evidenceId: passage.id, start: passage.start, end: passage.end })),
      status: "answered",
      providerId: this.id,
    };
  }
}
