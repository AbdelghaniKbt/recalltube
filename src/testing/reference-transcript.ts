import type { TranscriptCue } from "../types/transcript";
import { coalesceCues } from "../transcript/parsers";

/**
 * Parses timestamped text fixtures used by the reference-video smoke tests.
 *
 * This module is never imported by an extension entrypoint. It accepts common panel-copy, SRT and
 * WebVTT shapes so maintainers can verify retrieval against known transcripts without committing
 * copyrighted transcript fixtures to the repository.
 */

const TIMESTAMP = /^(?:(\d{1,3}):)?(\d{1,3}):(\d{2})(?:[.,](\d{1,3}))?$/;
const CUE_RANGE = /^(\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*-->\s*(\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)/;
const INLINE = /^[[(]?(\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)[\])]?[\s\t:-]*(\S[\s\S]*)$/;

export function parseReferenceTimecode(value: string): number | undefined {
  const match = TIMESTAMP.exec(value.trim());
  if (!match) return undefined;
  const [, hours, minutes, seconds, fraction] = match;
  const total =
    Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(`0.${fraction ?? 0}`);
  return Number.isFinite(total) ? total : undefined;
}

function isNoise(line: string): boolean {
  return !line || /^WEBVTT/i.test(line) || /^(NOTE|STYLE|REGION)\b/.test(line) || /^\d+$/.test(line);
}

export function parseReferenceTranscript(input: string): TranscriptCue[] {
  const lines = input
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim());

  const cues: TranscriptCue[] = [];
  let pendingStart: number | undefined;
  let pendingEnd: number | undefined;
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join(" ").replace(/\s+/gu, " ").trim();
    buffer = [];
    if (pendingStart === undefined || !text) {
      pendingStart = undefined;
      pendingEnd = undefined;
      return;
    }
    cues.push({ start: pendingStart, end: pendingEnd ?? pendingStart, text });
    pendingStart = undefined;
    pendingEnd = undefined;
  };

  for (const line of lines) {
    const range = CUE_RANGE.exec(line);
    if (range) {
      flush();
      pendingStart = parseReferenceTimecode(range[1]!);
      pendingEnd = parseReferenceTimecode(range[2]!);
      continue;
    }

    const alone = parseReferenceTimecode(line);
    if (alone !== undefined) {
      flush();
      pendingStart = alone;
      continue;
    }

    const inline = INLINE.exec(line);
    if (inline) {
      const start = parseReferenceTimecode(inline[1]!);
      if (start !== undefined) {
        flush();
        pendingStart = start;
        buffer.push(inline[2]!);
        flush();
        continue;
      }
    }

    if (isNoise(line)) {
      if (!line && pendingEnd !== undefined) flush();
      continue;
    }
    buffer.push(line);
  }
  flush();

  for (let index = 0; index < cues.length - 1; index += 1) {
    const current = cues[index]!;
    if (current.end <= current.start) current.end = cues[index + 1]!.start;
  }
  const last = cues.at(-1);
  if (last && last.end <= last.start) last.end = last.start + 4;
  return coalesceCues(cues);
}
