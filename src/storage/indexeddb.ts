import type { TranscriptChunk, TranscriptDocument } from "../types/transcript";
import type { PlaylistIndexJob, PlaylistInventory } from "../types/playlist";

/**
 * Local caches for transcripts and embeddings.
 *
 * Three cache-consistency defects are handled here:
 *
 *   - Writes resolved on `request.onsuccess` and closed the connection immediately, so a
 *     transaction that later aborted (quota being the realistic trigger) still reported success.
 *     We now resolve on `transaction.oncomplete`.
 *   - A new connection was opened and closed per operation. We keep one.
 *   - Embedding keys ignored content, language, model and chunker, so different transcripts
 *     collided. Keys are now derived from the full identity of what produced the vectors.
 */

const DATABASE_NAME = "recalltube";
/** Bump to migrate; `onupgradeneeded` drops incompatible stores rather than guessing. */
const DATABASE_VERSION = 3;

const TRANSCRIPTS = "transcripts";
const EMBEDDINGS = "embeddings";
const PLAYLISTS = "playlists";
const PLAYLIST_JOBS = "playlistJobs";

/** Keeps the cache bounded without asking the user to manage it. */
const MAX_TRANSCRIPTS = 1_000;
const MAX_EMBEDDING_RECORDS = 250;
const MAX_PLAYLISTS = 100;
const MAX_PLAYLIST_JOBS = 25;

interface StoredPlaylist extends PlaylistInventory {
  updatedAt: number;
}

export interface StoredTranscript {
  transcriptId: string;
  videoId: string;
  document: TranscriptDocument;
  updatedAt: number;
}

/** Everything that changes the meaning of a stored vector. */
export interface EmbeddingIdentity {
  transcriptId: string;
  modelId: string;
  modelRevision: string;
  dtype: string;
  pooling: string;
  dimension: number;
  chunkerVersion: number;
  normalizerVersion: number;
}

export interface EmbeddingRecord extends EmbeddingIdentity {
  key: string;
  videoId: string;
  chunks: TranscriptChunk[];
  /** Row-major, `chunks.length * dimension`. Float32 halves the size of the old `number[][]`. */
  vectors: Float32Array;
  createdAt: number;
}

export function embeddingKey(identity: EmbeddingIdentity): string {
  return [
    identity.transcriptId,
    identity.modelId,
    identity.modelRevision,
    identity.dtype,
    identity.pooling,
    String(identity.dimension),
    `c${identity.chunkerVersion}`,
    `n${identity.normalizerVersion}`,
  ].join("|");
}

let connection: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (connection) return connection;
  connection = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      // Records from version 1 used a colliding key scheme and `number[][]` vectors; there is
      // nothing worth migrating, and keeping them would serve wrong results.
      if (event.oldVersion < 2) {
        for (const name of [TRANSCRIPTS, EMBEDDINGS]) {
          if (database.objectStoreNames.contains(name)) database.deleteObjectStore(name);
        }
      }
      if (!database.objectStoreNames.contains(TRANSCRIPTS)) {
        const transcripts = database.createObjectStore(TRANSCRIPTS, { keyPath: "transcriptId" });
        transcripts.createIndex("videoId", "videoId", { unique: false });
        transcripts.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      if (!database.objectStoreNames.contains(EMBEDDINGS)) {
        const embeddings = database.createObjectStore(EMBEDDINGS, { keyPath: "key" });
        embeddings.createIndex("createdAt", "createdAt", { unique: false });
      }
      if (!database.objectStoreNames.contains(PLAYLISTS)) {
        const playlists = database.createObjectStore(PLAYLISTS, { keyPath: "playlistId" });
        playlists.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      if (!database.objectStoreNames.contains(PLAYLIST_JOBS)) {
        const jobs = database.createObjectStore(PLAYLIST_JOBS, { keyPath: "jobId" });
        jobs.createIndex("playlistId", "playlistId", { unique: false });
        jobs.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      // A version change from another tab invalidates this handle.
      database.onversionchange = () => {
        database.close();
        connection = undefined;
      };
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error("Unable to open the local cache."));
  }).catch((error: unknown) => {
    connection = undefined;
    throw error;
  });
  return connection;
}

/** Runs `operation` and resolves only once the transaction has actually committed. */
async function withStore<T>(
  storeNames: string | string[],
  mode: IDBTransactionMode,
  operation: (stores: IDBObjectStore[]) => IDBRequest<T> | { result: T }
): Promise<T> {
  const database = await openDatabase();
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(names, mode);
    let value: T | undefined;
    const outcome = operation(names.map((name) => transaction.objectStore(name)));
    if ("onsuccess" in outcome) {
      outcome.onsuccess = () => {
        value = outcome.result;
      };
      outcome.onerror = () => reject(outcome.error ?? new Error("Local cache operation failed."));
    } else {
      value = outcome.result;
    }
    transaction.oncomplete = () => resolve(value as T);
    transaction.onabort = () => reject(transaction.error ?? new Error("Local cache transaction aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Local cache transaction failed."));
  });
}

export async function saveTranscript(document: TranscriptDocument): Promise<void> {
  const record: StoredTranscript = {
    transcriptId: document.transcriptId,
    videoId: document.video.id,
    document,
    updatedAt: Date.now(),
  };
  await withStore(TRANSCRIPTS, "readwrite", ([store]) => store!.put(record));
  await evict(TRANSCRIPTS, "updatedAt", MAX_TRANSCRIPTS);
}

export function loadTranscriptById(transcriptId: string): Promise<StoredTranscript | undefined> {
  return withStore(TRANSCRIPTS, "readonly", ([store]) => store!.get(transcriptId));
}

/** Most recent cached transcript for a video, used to render instantly while re-acquiring. */
export async function loadTranscriptForVideo(videoId: string): Promise<StoredTranscript | undefined> {
  const matches = await withStore<StoredTranscript[]>(TRANSCRIPTS, "readonly", ([store]) =>
    store!.index("videoId").getAll(videoId)
  );
  return matches.sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

/**
 * Loads one latest transcript per requested video in one transaction.
 *
 * One `videoId` index lookup per requested video. The previous `getAll()` over the whole store
 * materialized every cached transcript — up to 1,000 full cue lists — to find a playlist's ten, on
 * every playlist-view render; the cost grew with the cache rather than with the playlist.
 */
export async function loadTranscriptsForVideos(videoIds: string[]): Promise<Map<string, StoredTranscript>> {
  const wanted = [...new Set(videoIds)];
  if (!wanted.length) return new Map();
  const records = await withStore<StoredTranscript[]>(TRANSCRIPTS, "readonly", ([store]) => {
    const index = store!.index("videoId");
    const collected: StoredTranscript[] = [];
    for (const videoId of wanted) {
      const request = index.getAll(videoId);
      request.onsuccess = () => {
        collected.push(...request.result);
      };
    }
    // Every request completes before the transaction does, so the array is full when it resolves.
    return { result: collected };
  });
  const latest = new Map<string, StoredTranscript>();
  for (const record of records) {
    const previous = latest.get(record.videoId);
    if (!previous || record.updatedAt > previous.updatedAt) latest.set(record.videoId, record);
  }
  return latest;
}

export async function savePlaylistInventory(inventory: PlaylistInventory): Promise<void> {
  await withStore(PLAYLISTS, "readwrite", ([store]) =>
    store!.put({ ...inventory, updatedAt: Date.now() } satisfies StoredPlaylist)
  );
  await evict(PLAYLISTS, "updatedAt", MAX_PLAYLISTS);
}

export function loadPlaylistInventory(playlistId: string): Promise<StoredPlaylist | undefined> {
  return withStore(PLAYLISTS, "readonly", ([store]) => store!.get(playlistId));
}

export async function savePlaylistJob(job: PlaylistIndexJob): Promise<void> {
  await withStore(PLAYLIST_JOBS, "readwrite", ([store]) => store!.put(job));
  await evict(PLAYLIST_JOBS, "updatedAt", MAX_PLAYLIST_JOBS);
}

export function loadPlaylistJob(jobId: string): Promise<PlaylistIndexJob | undefined> {
  return withStore(PLAYLIST_JOBS, "readonly", ([store]) => store!.get(jobId));
}

export async function loadLatestPlaylistJob(playlistId: string): Promise<PlaylistIndexJob | undefined> {
  const jobs = await withStore<PlaylistIndexJob[]>(PLAYLIST_JOBS, "readonly", ([store]) =>
    store!.index("playlistId").getAll(playlistId)
  );
  return jobs.sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

export async function loadResumablePlaylistJobs(): Promise<PlaylistIndexJob[]> {
  const jobs = await withStore<PlaylistIndexJob[]>(PLAYLIST_JOBS, "readonly", ([store]) => store!.getAll());
  return jobs.filter((job) => job.state === "running" || job.state === "queued");
}

/**
 * Jobs that still record an extension-owned worker, whatever their state.
 *
 * A job suspended while paused, cancelled or completed is not resumable, so nothing else revisits
 * it — but the tab or window it created can outlive the service worker, and only these persisted
 * ids identify it. Cleanup by id can never touch a tab the user opened.
 */
export async function loadPlaylistJobsOwningWorkers(): Promise<PlaylistIndexJob[]> {
  const jobs = await withStore<PlaylistIndexJob[]>(PLAYLIST_JOBS, "readonly", ([store]) => store!.getAll());
  return jobs.filter((job) => job.workerTabId !== undefined || job.workerWindowId !== undefined);
}

export async function clearPlaylistData(playlistId: string): Promise<void> {
  await withStore(PLAYLISTS, "readwrite", ([store]) => store!.delete(playlistId));
  const jobs = await withStore<PlaylistIndexJob[]>(PLAYLIST_JOBS, "readonly", ([store]) =>
    store!.index("playlistId").getAll(playlistId)
  );
  await withStore(PLAYLIST_JOBS, "readwrite", ([store]) => {
    for (const job of jobs) store!.delete(job.jobId);
    return { result: undefined };
  });
}

export async function saveEmbeddingRecord(record: EmbeddingRecord): Promise<void> {
  await withStore(EMBEDDINGS, "readwrite", ([store]) => store!.put(record));
  await evict(EMBEDDINGS, "createdAt", MAX_EMBEDDING_RECORDS);
}

export function loadEmbeddingRecord(key: string): Promise<EmbeddingRecord | undefined> {
  return withStore(EMBEDDINGS, "readonly", ([store]) => store!.get(key));
}

/** Drops the oldest records once a store exceeds `keep`. */
async function evict(storeName: string, indexName: string, keep: number): Promise<void> {
  try {
    const count = await withStore<number>(storeName, "readonly", ([store]) => store!.count());
    if (count <= keep) return;
    const excess = count - keep;
    await withStore(storeName, "readwrite", ([store]) => {
      let removed = 0;
      const cursorRequest = store!.index(indexName).openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || removed >= excess) return;
        cursor.delete();
        removed += 1;
        cursor.continue();
      };
      return { result: undefined };
    });
  } catch {
    // Eviction is best-effort; failing to trim must never fail the write that triggered it.
  }
}

export interface StorageUsage {
  transcripts: number;
  embeddingRecords: number;
  playlists: number;
  playlistJobs: number;
  usageBytes?: number;
  quotaBytes?: number;
}

export async function storageUsage(): Promise<StorageUsage> {
  const [transcripts, embeddingRecords, playlists, playlistJobs] = await Promise.all([
    withStore<number>(TRANSCRIPTS, "readonly", ([store]) => store!.count()).catch(() => 0),
    withStore<number>(EMBEDDINGS, "readonly", ([store]) => store!.count()).catch(() => 0),
    withStore<number>(PLAYLISTS, "readonly", ([store]) => store!.count()).catch(() => 0),
    withStore<number>(PLAYLIST_JOBS, "readonly", ([store]) => store!.count()).catch(() => 0),
  ]);
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  return {
    transcripts,
    embeddingRecords,
    playlists,
    playlistJobs,
    usageBytes: estimate?.usage,
    quotaBytes: estimate?.quota,
  };
}

export async function clearTranscriptsForVideo(videoId: string): Promise<void> {
  const matches = await withStore<StoredTranscript[]>(TRANSCRIPTS, "readonly", ([store]) =>
    store!.index("videoId").getAll(videoId)
  );
  const ids = new Set(matches.map((match) => match.transcriptId));
  await withStore(TRANSCRIPTS, "readwrite", ([store]) => {
    for (const id of ids) store!.delete(id);
    return { result: undefined };
  });
  await withStore(EMBEDDINGS, "readwrite", ([store]) => {
    const cursorRequest = store!.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      if ((cursor.value as EmbeddingRecord).videoId === videoId) cursor.delete();
      cursor.continue();
    };
    return { result: undefined };
  });
}

export async function clearStore(target: "transcripts" | "embeddings" | "all"): Promise<void> {
  const names =
    target === "all"
      ? [TRANSCRIPTS, EMBEDDINGS, PLAYLISTS, PLAYLIST_JOBS]
      : [target === "transcripts" ? TRANSCRIPTS : EMBEDDINGS];
  await withStore(names, "readwrite", (stores) => {
    for (const store of stores) store.clear();
    return { result: undefined };
  });
}

/**
 * Deletes the model weights transformers.js cached in CacheStorage. This is the only handle the
 * browser gives us on downloaded model data, and the user must be able to reclaim it.
 */
export async function clearModelCache(): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  const names = await caches.keys();
  let deleted = false;
  for (const name of names) {
    if (name.includes("transformers")) deleted = (await caches.delete(name)) || deleted;
  }
  return deleted;
}
