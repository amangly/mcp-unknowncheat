import { navigateWithRetry, validateUrl } from "./browser.js";
import { normalizeThreadUrl } from "./forum-url.js";

const CACHE_TTL_MS = Number(process.env.UC_CACHE_TTL_MS ?? 5 * 60_000);
const MIN_REQUEST_INTERVAL_MS = Number(process.env.UC_MIN_REQUEST_INTERVAL_MS ?? 900);
const CACHE_MAX_ENTRIES = 128;

interface CacheEntry {
  html: string;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<string>>();
let queueTail: Promise<void> = Promise.resolve();
let lastRequestAt = 0;
const metrics = { cacheHits: 0, joinedRequests: 0, requests: 0, failures: 0, totalFetchMs: 0, totalQueueMs: 0 };

function evictIfNeeded(): void {
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const oldestKey = cache.keys().next().value;
  if (oldestKey !== undefined) cache.delete(oldestKey);
}

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

export interface FetchOptions {
  bypassCache?: boolean;
  cacheOverrideTtlMs?: number;
  deadlineAt?: number;
}

export async function fetchHtml(url: string, opts: FetchOptions = {}): Promise<string> {
  url = normalizeThreadUrl(url);
  validateUrl(url);
  const ttl = opts.cacheOverrideTtlMs ?? CACHE_TTL_MS;

  if (!opts.bypassCache) {
    const cached = cache.get(url);
    if (cached && Date.now() - cached.timestamp < ttl) {
      cache.delete(url);
      cache.set(url, cached);
      metrics.cacheHits++;
      console.error(`[crawl] Cache hit: ${url}`);
      return cached.html;
    }
  }

  const key = `${url}\0${Boolean(opts.bypassCache)}\0${opts.deadlineAt ?? ""}`;
  const existing = pending.get(key);
  if (existing) {
    metrics.joinedRequests++;
    return existing;
  }
  const queuedAt = Date.now();
  const request = queueTail.then(async () => {
    if (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt) {
      throw new Error("Fetch time budget exhausted while queued");
    }
    metrics.totalQueueMs += Date.now() - queuedAt;
    if (!opts.bypassCache) {
      const cached = cache.get(url);
      if (cached && Date.now() - cached.timestamp < ttl) {
        metrics.cacheHits++;
        return cached.html;
      }
    }
    await throttle();
    if (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt) {
      throw new Error("Fetch time budget exhausted after throttle");
    }
    const startedAt = Date.now();
    metrics.requests++;
    try {
      const { html } = await navigateWithRetry(url, opts.deadlineAt);
      cache.delete(url);
      cache.set(url, { html, timestamp: Date.now() });
      evictIfNeeded();
      return html;
    } catch (error) {
      metrics.failures++;
      throw error;
    } finally {
      metrics.totalFetchMs += Date.now() - startedAt;
    }
  });
  queueTail = request.then(() => undefined, () => undefined);
  pending.set(key, request);
  try {
    return await request;
  } finally {
    pending.delete(key);
  }
}

export function clearCache(): number {
  const size = cache.size;
  cache.clear();
  return size;
}

export function getCacheStats() {
  return { entries: cache.size, pending: pending.size, ttlMs: CACHE_TTL_MS,
    minIntervalMs: MIN_REQUEST_INTERVAL_MS, ...metrics };
}
