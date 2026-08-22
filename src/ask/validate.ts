import type { EvidencePassage, GroundedAnswer } from "./types";
import { INSUFFICIENT_EVIDENCE_MESSAGE } from "./types";

/**
 * Validates a generated answer against the evidence we actually supplied.
 *
 * This is the defence that does not depend on the model behaving. Even if a transcript convinces
 * the model to ignore its instructions, an answer that cites nothing we provided is rejected here
 * and downgraded to "insufficient evidence".
 */

const MAX_ANSWER_CHARACTERS = 2_000;

export function insufficient(providerId: string): GroundedAnswer {
  return {
    answer: INSUFFICIENT_EVIDENCE_MESSAGE,
    citations: [],
    status: "insufficient-evidence",
    providerId,
  };
}

/** Pulls the first JSON object out of a response that may be fenced or prefixed with prose. */
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to a brace scan.
  }
  const start = trimmed.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, index + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * Turns a raw model response into a `GroundedAnswer`, or into an explicit insufficient-evidence
 * result. Never throws: an unusable answer is a product state, not an exception.
 */
export function validateAnswer(
  raw: string,
  evidence: EvidencePassage[],
  providerId: string
): GroundedAnswer {
  const parsed = extractJsonObject(raw);
  if (typeof parsed !== "object" || parsed === null) return insufficient(providerId);

  const record = parsed as Record<string, unknown>;
  const status = record.status === "answered" ? "answered" : "insufficient-evidence";
  const answer = typeof record.answer === "string" ? record.answer.trim() : "";

  if (status === "insufficient-evidence" || !answer) return insufficient(providerId);

  const byId = new Map(evidence.map((passage) => [passage.id, passage]));
  const citations: GroundedAnswer["citations"] = [];
  const seen = new Set<string>();

  if (Array.isArray(record.citations)) {
    for (const entry of record.citations) {
      const id =
        typeof entry === "string"
          ? entry
          : typeof entry === "object" && entry !== null
            ? (entry as Record<string, unknown>).evidenceId
            : undefined;
      if (typeof id !== "string") continue;
      const passage = byId.get(id);
      // A citation we did not supply is the signature of a model that went off-evidence.
      if (!passage || seen.has(id)) continue;
      seen.add(id);
      citations.push({ evidenceId: id, start: passage.start, end: passage.end });
    }
  }

  // An answer with no verifiable citation is exactly what prompt injection tries to produce.
  if (!citations.length) return insufficient(providerId);

  return {
    answer: answer.slice(0, MAX_ANSWER_CHARACTERS),
    citations,
    status: "answered",
    providerId,
  };
}
