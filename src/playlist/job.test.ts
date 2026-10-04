import { describe, expect, it } from "vitest";
import {
  createPlaylistJob,
  finalizeJob,
  markItemFailed,
  markItemIndexing,
  markItemReady,
  playlistCoverage,
  requeueForAutomaticRetry,
  resetRetryableItems,
} from "./job";
import type { PlaylistInventory } from "../types/playlist";
import type { TranscriptDocument } from "../types/transcript";

const inventory: PlaylistInventory = {
  playlistId: "PL1234567890abcdef",
  title: "Series",
  complete: true,
  sources: ["dom"],
  collectedAt: 1,
  items: [
    { videoId: "aaa12345678", title: "A", position: 0 },
    { videoId: "bbb12345678", title: "B", position: 1 },
    { videoId: "ccc12345678", title: "C", position: 2 },
  ],
};

const transcript = (videoId: string): TranscriptDocument => ({
  transcriptId: `t-${videoId}`,
  video: { id: videoId, title: videoId, url: `https://www.youtube.com/watch?v=${videoId}` },
  cues: [{ start: 0, end: 2, text: "Hello" }],
  source: "player",
  fetchedAt: 1,
  parserVersion: 1,
});

describe("playlist jobs", () => {
  it("tracks searchable coverage without hiding failures", () => {
    let job = createPlaylistJob(inventory, { jobId: "job", now: 10 });
    job = { ...job, state: "running" };
    job = markItemIndexing(job, "aaa12345678", 11);
    job = markItemReady(job, "aaa12345678", transcript("aaa12345678"), false, 12);
    job = markItemReady(job, "bbb12345678", transcript("bbb12345678"), true, 13);
    job = markItemFailed(job, "ccc12345678", "no-captions", 14);
    expect(playlistCoverage(job)).toEqual({
      total: 3,
      searchable: 2,
      indexed: 1,
      cached: 1,
      pending: 0,
      unavailable: 1,
      failed: 0,
    });
    job = { ...job, workerTabId: 42, workerWindowId: 43 };
    expect(finalizeJob(job, 15)).toMatchObject({
      state: "completed",
      finishedAt: 15,
      workerTabId: 42,
      workerWindowId: 43,
    });
  });

  it("resets only retryable failures and interrupted work", () => {
    let job = createPlaylistJob(inventory, { jobId: "job", now: 10 });
    job = markItemFailed(job, "aaa12345678", "network-error", 11);
    job = markItemFailed(job, "bbb12345678", "no-captions", 12);
    job = markItemIndexing(job, "ccc12345678", 13);
    const retry = resetRetryableItems(job, 14);
    expect(retry.items.map((item) => item.state)).toEqual(["pending", "no-captions", "pending"]);
  });

  it("requeues only transient failures, only until the attempt budget is spent", () => {
    let job = createPlaylistJob(inventory, { jobId: "job", now: 10 });
    job = markItemIndexing(job, "aaa12345678", 11);
    job = markItemFailed(job, "aaa12345678", "captions-withheld", 12);
    job = markItemIndexing(job, "bbb12345678", 13);
    job = markItemFailed(job, "bbb12345678", "no-captions", 14);
    for (let attempt = 0; attempt < 3; attempt += 1) job = markItemIndexing(job, "ccc12345678", 15);
    job = markItemFailed(job, "ccc12345678", "not-ready", 16);

    const retried = requeueForAutomaticRetry(job, 3, 17);
    expect(retried.items.map((item) => [item.state, item.attempts])).toEqual([
      ["pending", 1],
      ["no-captions", 1],
      ["failed", 3],
    ]);
    expect(requeueForAutomaticRetry(retried, 3, 18)).toBe(retried);
  });

  it("gives a manual retry a fresh automatic budget", () => {
    let job = createPlaylistJob(inventory, { jobId: "job", now: 10 });
    for (let attempt = 0; attempt < 3; attempt += 1) job = markItemIndexing(job, "aaa12345678", 11);
    job = markItemFailed(job, "aaa12345678", "not-ready", 12);
    expect(resetRetryableItems(job, 13).items[0]).toMatchObject({ state: "pending", attempts: 0 });
  });
});
