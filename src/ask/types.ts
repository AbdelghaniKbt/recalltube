/** A transcript passage offered to an answer provider as evidence. Always untrusted content. */
export interface EvidencePassage {
  /** Stable, short id the model must cite. */
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface GroundedAnswerRequest {
  question: string;
  evidence: EvidencePassage[];
  /** Language hint for the answer; the question's language is used when unset. */
  languageHint?: string;
}

export interface AnswerCitation {
  evidenceId: string;
  start: number;
  end: number;
}

export interface GroundedAnswer {
  answer: string;
  citations: AnswerCitation[];
  status: "answered" | "insufficient-evidence";
  /** Which provider produced this, so the UI can be honest about how it was generated. */
  providerId: string;
}

export type AnswerAvailability = "available" | "downloadable" | "unavailable" | "unsupported";

export interface GroundedAnswerProvider {
  readonly id: string;
  availability(): Promise<AnswerAvailability>;
  answer(request: GroundedAnswerRequest, signal?: AbortSignal): Promise<GroundedAnswer>;
}

export const INSUFFICIENT_EVIDENCE_MESSAGE = "I could not find enough evidence in this transcript.";
