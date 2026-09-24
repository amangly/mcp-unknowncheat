import { navigateWithRetry, validateUrl } from "./browser.js";

const CACHE_TTL_MS = Number(process.env.UC_CACHE_TTL_MS ?? 5 * 60_000);
const MIN_REQUEST_INTERVAL_MS = Number(process.env.UC_MIN_REQUEST_INTERVAL_MS ?? 900);
const CACHE_MAX_ENTRIES = 128;

interface CacheEntry {
  html: string;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
let lastRequestAt = 0;

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
}

export async function fetchHtml(url: string, opts: FetchOptions = {}): Promise<string> {
  validateUrl(url);
  const ttl = opts.cacheOverrideTtlMs ?? CACHE_TTL_MS;

  if (!opts.bypassCache) {
    const cached = cache.get(url);
    if (cached && Date.now() - cached.timestamp < ttl) {
      console.error(`[crawl] Cache hit: ${url}`);
      return cached.html;
    }
  }

  await throttle();
  const { html } = await navigateWithRetry(url);
  cache.set(url, { html, timestamp: Date.now() });
  evictIfNeeded();
  return html;
}

export function clearCache(): number {
  const size = cache.size;
  cache.clear();
  return size;
}

export function getCacheStats(): { entries: number; ttlMs: number; minIntervalMs: number } {
  return { entries: cache.size, ttlMs: CACHE_TTL_MS, minIntervalMs: MIN_REQUEST_INTERVAL_MS };
}
