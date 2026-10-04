import type {
  PlaylistCoverage,
  PlaylistIndexItem,
  PlaylistIndexJob,
  PlaylistInventory,
  PlaylistItemState,
} from "../types/playlist";
import type { AcquisitionFailureReason, TranscriptDocument } from "../types/transcript";
import type { AdapterDiagnostic } from "../types/transcript";

export function createPlaylistJob(
  inventory: PlaylistInventory,
  options: { jobId?: string; ownerTabId?: number; now?: number } = {}
): PlaylistIndexJob {
  const now = options.now ?? Date.now();
  return {
    jobId: options.jobId ?? crypto.randomUUID(),
    playlistId: inventory.playlistId,
    playlistTitle: inventory.title,
    ownerTabId: options.ownerTabId,
    state: "queued",
    items: inventory.items.map((item) => ({ ...item, state: "pending", attempts: 0, updatedAt: now })),
    createdAt: now,
    updatedAt: now,
  };
}

export function playlistCoverage(job: PlaylistIndexJob): PlaylistCoverage {
  const count = (states: PlaylistItemState[]) => job.items.filter((item) => states.includes(item.state)).length;
  const indexed = count(["indexed"]);
  const cached = count(["cached"]);
  return {
    total: job.items.length,
    searchable: indexed + cached,
    indexed,
    cached,
    pending: count(["pending", "indexing"]),
    unavailable: count(["no-captions", "unavailable"]),
    failed: count(["failed"]),
  };
}

export function nextPendingItem(job: PlaylistIndexJob): PlaylistIndexItem | undefined {
  return job.items.find((item) => item.state === "pending" || item.state === "indexing");
}

export function markItemIndexing(job: PlaylistIndexJob, videoId: string, now = Date.now()): PlaylistIndexJob {
  return updateItem(job, videoId, (item) => ({
    ...item,
    state: "indexing",
    attempts: item.attempts + 1,
    failureReason: undefined,
    diagnostics: undefined,
    updatedAt: now,
  }), now);
}

export function markItemReady(
  job: PlaylistIndexJob,
  videoId: string,
  document: TranscriptDocument,
  cached: boolean,
  now = Date.now()
): PlaylistIndexJob {
  return updateItem(job, videoId, (item) => ({
    ...item,
    title: document.video.title || item.title,
    state: cached ? "cached" : "indexed",
    transcriptId: document.transcriptId,
    failureReason: undefined,
    diagnostics: undefined,
    updatedAt: now,
  }), now);
}

function failureState(reason: AcquisitionFailureReason): PlaylistItemState {
  if (reason === "no-captions") return "no-captions";
  if (reason === "permission-denied" || reason === "unsupported" || reason === "video-unavailable") return "unavailable";
  return "failed";
}

export function markItemFailed(
  job: PlaylistIndexJob,
  videoId: string,
  reason: AcquisitionFailureReason,
  now = Date.now(),
  diagnostics?: AdapterDiagnostic[]
): PlaylistIndexJob {
  return updateItem(job, videoId, (item) => ({
    ...item,
    state: failureState(reason),
    failureReason: reason,
    diagnostics,
    updatedAt: now,
  }), now);
}

/** A manual retry starts a fresh automatic-retry budget for every failed item. */
export function resetRetryableItems(job: PlaylistIndexJob, now = Date.now()): PlaylistIndexJob {
  return {
    ...job,
    state: "queued",
    finishedAt: undefined,
    lastError: undefined,
    updatedAt: now,
    items: job.items.map((item) =>
      item.state === "failed" || item.state === "indexing"
        ? { ...item, state: "pending", failureReason: undefined, attempts: 0, updatedAt: now }
        : item
    ),
  };
}

/** Attempts per item before a failure is left for the user. */
export const MAX_AUTOMATIC_ATTEMPTS = 3;

/**
 * Queues another pass over failures that may succeed on a later attempt.
 *
 * Users saw every click of "Retry failures" make more videos searchable: first passes failed on
 * slower machines and a second pass, with YouTube's resources cached, succeeded. Doing that pass
 * automatically — after the rest of the queue, so a transient condition has time to clear — makes
 * the job reach the coverage a user would otherwise reach by clicking. "failed" is the only state
 * retried; "no-captions" and "unavailable" are YouTube's answer, not a transient failure.
 */
export function requeueForAutomaticRetry(
  job: PlaylistIndexJob,
  maxAttempts = MAX_AUTOMATIC_ATTEMPTS,
  now = Date.now()
): PlaylistIndexJob {
  let requeued = false;
  const items = job.items.map((item) => {
    if (item.state !== "failed" || item.attempts >= maxAttempts) return item;
    requeued = true;
    return { ...item, state: "pending" as const, updatedAt: now };
  });
  return requeued ? { ...job, items, updatedAt: now } : job;
}

/**
 * Restores an item interrupted by worker suspension without retrying completed failures.
 *
 * Deliberately leaves `workerTabId`/`workerWindowId` alone. Forgetting them here orphaned the tab:
 * they are the only handle on an extension-owned worker, and clearing them out from under a
 * cleanup that was still running made it close nothing. Closing is the caller's job.
 */
export function resetInterruptedItem(job: PlaylistIndexJob, now = Date.now()): PlaylistIndexJob {
  return {
    ...job,
    state: "queued",
    updatedAt: now,
    items: job.items.map((item) =>
      item.state === "indexing" ? { ...item, state: "pending", updatedAt: now } : item
    ),
  };
}

export function finalizeJob(job: PlaylistIndexJob, now = Date.now()): PlaylistIndexJob {
  const pending = nextPendingItem(job);
  if (pending) return job;
  return {
    ...job,
    state: "completed",
    updatedAt: now,
    finishedAt: now,
  };
}

function updateItem(
  job: PlaylistIndexJob,
  videoId: string,
  update: (item: PlaylistIndexItem) => PlaylistIndexItem,
  now: number
): PlaylistIndexJob {
  let found = false;
  const items = job.items.map((item) => {
    if (item.videoId !== videoId) return item;
    found = true;
    return update(item);
  });
  return found ? { ...job, items, updatedAt: now } : job;
}
