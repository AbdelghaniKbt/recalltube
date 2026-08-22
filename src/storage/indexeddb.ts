import type { TranscriptChunk, TranscriptDocument } from "../types/transcript";

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
const DATABASE_VERSION = 2;

const TRANSCRIPTS = "transcripts";
const EMBEDDINGS = "embeddings";

/** Keeps the cache bounded without asking the user to manage it. */
const MAX_TRANSCRIPTS = 200;
const MAX_EMBEDDING_RECORDS = 40;

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
    request.onupgradeneeded = () => {
      const database = request.result;
      // Records from version 1 used a colliding key scheme and `number[][]` vectors; there is
      // nothing worth migrating, and keeping them would serve wrong results.
      for (const name of [TRANSCRIPTS, EMBEDDINGS]) {
        if (database.objectStoreNames.contains(name)) database.deleteObjectStore(name);
      }
      const transcripts = database.createObjectStore(TRANSCRIPTS, { keyPath: "transcriptId" });
      transcripts.createIndex("videoId", "videoId", { unique: false });
      transcripts.createIndex("updatedAt", "updatedAt", { unique: false });
      const embeddings = database.createObjectStore(EMBEDDINGS, { keyPath: "key" });
      embeddings.createIndex("createdAt", "createdAt", { unique: false });
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
  usageBytes?: number;
  quotaBytes?: number;
}

export async function storageUsage(): Promise<StorageUsage> {
  const [transcripts, embeddingRecords] = await Promise.all([
    withStore<number>(TRANSCRIPTS, "readonly", ([store]) => store!.count()).catch(() => 0),
    withStore<number>(EMBEDDINGS, "readonly", ([store]) => store!.count()).catch(() => 0),
  ]);
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  return {
    transcripts,
    embeddingRecords,
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
    target === "all" ? [TRANSCRIPTS, EMBEDDINGS] : [target === "transcripts" ? TRANSCRIPTS : EMBEDDINGS];
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
