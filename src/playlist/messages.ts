import { parsePlaylistInventory } from "./inventory";
import { cleanPlaylistId } from "./url";
import type { PlaylistIndexJob, PlaylistInventory } from "../types/playlist";

export type PlaylistCommand =
  | { type: "recalltube:playlist-start"; inventory: PlaylistInventory; ownerTabId?: number }
  | { type: "recalltube:playlist-get"; playlistId: string }
  | { type: "recalltube:playlist-pause"; jobId: string }
  | { type: "recalltube:playlist-resume"; jobId: string }
  | { type: "recalltube:playlist-cancel"; jobId: string }
  | { type: "recalltube:playlist-retry"; jobId: string };

export interface PlaylistCommandResponse {
  ok: boolean;
  job?: PlaylistIndexJob;
  error?: string;
}

export interface PlaylistJobChangedMessage {
  type: "recalltube:playlist-job-changed";
  job: PlaylistIndexJob;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function jobId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,80}$/u.test(value) ? value : undefined;
}

export function parsePlaylistCommand(value: unknown): PlaylistCommand | undefined {
  const raw = record(value);
  if (!raw || typeof raw.type !== "string") return undefined;
  if (raw.type === "recalltube:playlist-start") {
    const inventory = parsePlaylistInventory(raw.inventory);
    if (!inventory?.items.length) return undefined;
    return {
      type: raw.type,
      inventory,
      ownerTabId:
        typeof raw.ownerTabId === "number" && Number.isSafeInteger(raw.ownerTabId) && raw.ownerTabId >= 0
          ? raw.ownerTabId
          : undefined,
    };
  }
  if (raw.type === "recalltube:playlist-get") {
    const playlistId = cleanPlaylistId(raw.playlistId);
    return playlistId ? { type: raw.type, playlistId } : undefined;
  }
  if (
    raw.type === "recalltube:playlist-pause" ||
    raw.type === "recalltube:playlist-resume" ||
    raw.type === "recalltube:playlist-cancel" ||
    raw.type === "recalltube:playlist-retry"
  ) {
    const id = jobId(raw.jobId);
    return id ? { type: raw.type, jobId: id } : undefined;
  }
  return undefined;
}

export function parsePlaylistJobChanged(value: unknown): PlaylistJobChangedMessage | undefined {
  const raw = record(value);
  if (!raw || raw.type !== "recalltube:playlist-job-changed") return undefined;
  const job = record(raw.job);
  if (!job || !jobId(job.jobId) || !cleanPlaylistId(job.playlistId) || !Array.isArray(job.items)) return undefined;
  return { type: "recalltube:playlist-job-changed", job: job as unknown as PlaylistIndexJob };
}
