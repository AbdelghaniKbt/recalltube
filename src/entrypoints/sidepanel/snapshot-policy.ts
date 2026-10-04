import type { PageSnapshot } from "../../types/transcript";

/** A snapshot together with the page document that produced it. */
export interface HeldSnapshot {
  snapshot: PageSnapshot;
  /** The content script instance's id; absent for snapshots the panel synthesized itself. */
  documentId?: string;
}

/**
 * Whether `next` should replace what the panel holds.
 *
 * Generations restart at 1 in every new document, so they are comparable only within one document.
 * Comparing them across documents meant that after a page reload (or an extension reload followed
 * by a tab reload) the new page's first result — generation 1 — lost to whatever higher generation
 * the replaced page had reached, and a transcript that had just been acquired was silently dropped
 * while the panel kept showing the old page's failure.
 */
export function shouldAdopt(current: HeldSnapshot, next: HeldSnapshot): boolean {
  if (next.snapshot.videoId !== current.snapshot.videoId) return true;
  if (current.documentId !== next.documentId) return true;
  return next.snapshot.generation >= current.snapshot.generation;
}
