import { buildRetrievalIndex, search, type HybridSearchOptions, type RetrievalIndex } from "../search/engine";
import type { PlaylistSearchResult, PlaylistTranscript } from "../types/playlist";
import type { SearchResult } from "../types/transcript";

function evidenceTier(result: SearchResult): number {
  if (result.signals.includes("exact")) return 4;
  if (result.signals.includes("boundary-exact")) return 3;
  if (result.signals.includes("semantic") && result.signals.includes("lexical")) return 2;
  if (result.signals.includes("semantic")) return 1;
  return 0;
}

export interface PlaylistRetrievalEntry extends PlaylistTranscript {
  index: RetrievalIndex;
}

/**
 * Builds retrieval state for every playlist transcript.
 *
 * With a `cache`, an index is built once per transcript id and reused across rebuilds, and indexes
 * for transcripts no longer present are dropped. The playlist view re-reads its transcripts on every
 * job update while indexing runs; rebuilding every unchanged video's flattened index each time cost
 * tens of milliseconds per video on the UI thread, per update.
 */
export function buildPlaylistRetrieval(
  entries: PlaylistTranscript[],
  cache?: Map<string, RetrievalIndex>
): PlaylistRetrievalEntry[] {
  const keep = new Set<string>();
  const built = entries.map((entry) => {
    const id = entry.transcript.transcriptId;
    keep.add(id);
    let index = cache?.get(id);
    if (!index) {
      index = buildRetrievalIndex(id, entry.transcript.cues);
      cache?.set(id, index);
    }
    return { ...entry, index };
  });
  if (cache) {
    for (const id of [...cache.keys()]) if (!keep.has(id)) cache.delete(id);
  }
  return built;
}

export function searchPlaylist(
  playlistId: string,
  entries: PlaylistRetrievalEntry[],
  query: string,
  options: Omit<HybridSearchOptions, "semantic"> & { semantic?: Map<string, SearchResult[]> }
): PlaylistSearchResult[] {
  const perVideoLimit = Math.min(20, options.limit ?? 25);
  const results = entries.flatMap((entry) =>
    search(entry.index, query, {
      mode: options.mode,
      limit: perVideoLimit,
      semantic: options.semantic?.get(entry.transcript.transcriptId),
    }).map((result, localRank) => ({
      playlistId,
      item: entry.item,
      transcript: entry.transcript,
      result: { ...result, id: `${entry.item.videoId}:${result.id}` },
      localRank,
    }))
  );
  return results
    .sort((left, right) => {
      // A hybrid score is intentionally comparable only within the transcript that produced it.
      // Across videos, rank by auditable evidence strength and ordinal rank instead of pretending
      // independent BM25/RRF scales are calibrated. Exact occurrences are naturally ordered by
      // playlist position and time because they are equally strong evidence.
      const tier = evidenceTier(right.result) - evidenceTier(left.result);
      if (tier) return tier;
      if (options.mode === "meaning" && left.localRank !== right.localRank) return left.localRank - right.localRank;
      return left.item.position - right.item.position || left.result.start - right.result.start;
    })
    .slice(0, options.limit ?? 50)
    .map(({ localRank: _localRank, ...result }) => result);
}
