import { buildUserPrompt, SYSTEM_INSTRUCTION } from "./prompt";
import { promptApiLanguage, type PromptApiLanguage } from "./language";
import { insufficient, validateAnswer } from "./validate";
import type {
  AnswerAvailability,
  GroundedAnswer,
  GroundedAnswerProvider,
  GroundedAnswerRequest,
} from "./types";

/**
 * Optional provider backed by Chrome's built-in on-device Prompt API.
 *
 * Strictly optional: it is feature-detected, never required, and never a cloud call. When the API
 * is missing, the device does not qualify, the model is not downloaded, or the question is in a
 * language the API cannot answer in, Ask falls back to the extractive provider. There is no cloud
 * LLM fallback in this release, by design.
 */

interface LanguageModelSession {
  prompt(input: string, options?: { signal?: AbortSignal; responseConstraint?: unknown }): Promise<string>;
  destroy?(): void;
}

/** Declares the languages a session will handle. Chrome requires this and warns without it. */
interface ExpectedLanguages {
  expectedInputs?: Array<{ type: "text"; languages: string[] }>;
  expectedOutputs?: Array<{ type: "text"; languages: string[] }>;
}

interface LanguageModelApi {
  availability(options?: ExpectedLanguages): Promise<string>;
  create(
    options?: ExpectedLanguages & {
      initialPrompts?: Array<{ role: string; content: string }>;
      signal?: AbortSignal;
      monitor?: (monitor: EventTarget) => void;
    }
  ): Promise<LanguageModelSession>;
}

/** JSON Schema handed to the Prompt API when it supports structured output. */
const RESPONSE_SCHEMA = {
  type: "object",
  required: ["answer", "citations", "status"],
  additionalProperties: false,
  properties: {
    answer: { type: "string" },
    status: { type: "string", enum: ["answered", "insufficient-evidence"] },
    citations: {
      type: "array",
      items: {
        type: "object",
        required: ["evidenceId"],
        additionalProperties: false,
        properties: { evidenceId: { type: "string" } },
      },
    },
  },
} as const;

function languageModel(): LanguageModelApi | undefined {
  return (globalThis as { LanguageModel?: LanguageModelApi }).LanguageModel;
}

/**
 * Transcript evidence can be in any language, so inputs are declared as the answer language plus
 * English. Outputs are a single language, because that is what Chrome accepts.
 */
function languageOptions(language: PromptApiLanguage): ExpectedLanguages {
  return {
    expectedInputs: [{ type: "text", languages: [...new Set([language, "en"])] }],
    expectedOutputs: [{ type: "text", languages: [language] }],
  };
}

export class PromptApiAnswerProvider implements GroundedAnswerProvider {
  readonly id = "chrome-prompt-api";

  /** Set per request; `availability()` alone cannot know the question's language. */
  constructor(private readonly language: PromptApiLanguage = "en") {}

  async availability(): Promise<AnswerAvailability> {
    const api = languageModel();
    if (!api || typeof api.availability !== "function") return "unsupported";
    try {
      const state = await api.availability(languageOptions(this.language));
      if (state === "available") return "available";
      if (state === "downloadable" || state === "downloading") return "downloadable";
      return "unavailable";
    } catch {
      return "unsupported";
    }
  }

  async answer(request: GroundedAnswerRequest, signal?: AbortSignal): Promise<GroundedAnswer> {
    const api = languageModel();
    if (!api) return insufficient(this.id);

    // Never ask the API for a language it cannot produce; the caller routes those to the
    // extractive provider, which answers in the transcript's own words.
    const language = promptApiLanguage(request.question) ?? this.language;

    let session: LanguageModelSession | undefined;
    try {
      session = await api.create({
        ...languageOptions(language),
        initialPrompts: [{ role: "system", content: SYSTEM_INSTRUCTION }],
        signal,
      });

      let raw: string;
      try {
        raw = await session.prompt(buildUserPrompt(request), { signal, responseConstraint: RESPONSE_SCHEMA });
      } catch {
        // Structured output is not available everywhere; the validator handles free-form JSON,
        // and an unusable response becomes insufficient-evidence rather than a fabricated answer.
        raw = await session.prompt(buildUserPrompt(request), { signal });
      }

      return validateAnswer(raw, request.evidence, this.id);
    } catch {
      return insufficient(this.id);
    } finally {
      session?.destroy?.();
    }
  }
}
