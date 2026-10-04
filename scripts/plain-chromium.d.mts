import type { Browser, BrowserContext, Worker } from "playwright";

/** Types for the plain-ESM launcher shared by the live scripts (see plain-chromium.mjs). */
export interface PlainChromiumSession {
  browser: Browser;
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  browserVersion: string;
  close(): Promise<void>;
}

export interface CaptionTrafficEntry {
  atSeconds: number;
  kind: string;
  status: number;
  bytes: number | null;
}

export function bundledChromium(): string;
export function launchPlainChromium(options?: { extensionPath?: string }): Promise<PlainChromiumSession>;
export function recordCaptionTraffic(context: BrowserContext, startedAt: number): CaptionTrafficEntry[];
export function recordMediaTraffic(context: BrowserContext): { responses: number; declaredBytes: number };
