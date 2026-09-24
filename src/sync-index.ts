import { fetchHtml } from "./crawl.js";
import { validateUrl } from "./browser.js";
import { ForumIndex } from "./forum-index.js";
import { parsePaginationInfo, parseThreadList, type ThreadListEntry } from "./parsers/thread-list.js";
import { parseThread } from "./parsers/thread.js";
import type { ThreadPost } from "./types.js";

export interface SyncResult {
  subforum: string;
  listingPages: number[];
  threadsSeen: number;
  threadsUpdated: number;
  threadsSkipped: number;
  postPagesFetched: number;
  timeBudgetReached: boolean;
  coverage: "first_and_recent_pages";
  errors: Array<{ url: string; message: string }>;
}

function listingUrl(slug: string, page: number): string {
  const base = `https://www.unknowncheats.me/forum/${slug}/`;
  return page === 1 ? base : `${base}index${page}.html`;
}

function threadPageUrl(url: string, page: number): string {
  const target = new URL(url);
  target.searchParams.set("page", String(page));
  return target.toString();
}

export async function syncSubforumIndex(
  index: ForumIndex,
  slug: string,
  options: { maxListingPages: number; maxThreads: number; recentPages: number; maxPostAgeMs?: number; deadlineAt?: number },
  fetcher: (url: string) => Promise<string> = fetchHtml,
): Promise<SyncResult> {
  if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(slug)) throw new Error("Invalid subforum slug");
  const result: SyncResult = {
    subforum: slug, listingPages: [], threadsSeen: 0, threadsUpdated: 0,
    threadsSkipped: 0, postPagesFetched: 0, timeBudgetReached: false,
    coverage: "first_and_recent_pages", errors: [],
  };
  const seen = new Map<string, ThreadListEntry>();

  for (let page = 1; page <= options.maxListingPages; page++) {
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
      result.timeBudgetReached = true;
      break;
    }
    const url = listingUrl(slug, page);
    try {
      const html = await fetcher(url);
      const entries = parseThreadList(html);
      if (entries.length === 0) throw new Error("No thread links parsed");
      const validEntries = entries.filter((entry) => {
        try {
          validateUrl(entry.url);
          return true;
        } catch {
          return false;
        }
      });
      if (validEntries.length === 0) throw new Error("No allowed thread URLs parsed");
      index.recordListing(slug, page, validEntries);
      for (const entry of validEntries) seen.set(entry.threadId, entry);
      result.listingPages.push(page);
      if (page >= parsePaginationInfo(html).totalPages) break;
    } catch (error) {
      if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) result.timeBudgetReached = true;
      result.errors.push({ url, message: error instanceof Error ? error.message : String(error) });
      break;
    }
  }

  result.threadsSeen = seen.size;
  let attempted = 0;
  for (const entry of seen.values()) {
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
      result.timeBudgetReached = true;
      break;
    }
    if (attempted >= options.maxThreads) break;
    if (!index.needsPosts(entry.threadId, options.maxPostAgeMs)) {
      result.threadsSkipped++;
      continue;
    }
    attempted++;
    try {
      const firstHtml = await fetcher(entry.url);
      const first = parseThread(firstHtml, entry.url, 1);
      if (first.posts.length === 0) throw new Error("No posts parsed from first page");
      const pages: Array<{ page: number; posts: ThreadPost[] }> = [{ page: 1, posts: first.posts }];
      const start = Math.max(2, first.totalPages - options.recentPages + 1);
      for (let page = start; page <= first.totalPages; page++) {
        if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
          result.timeBudgetReached = true;
          throw new Error("Time budget reached before all sampled post pages were fetched");
        }
        const url = threadPageUrl(entry.url, page);
        const parsed = parseThread(await fetcher(url), url, page);
        if (parsed.posts.length === 0) throw new Error(`No posts parsed from page ${page}`);
        pages.push({ page, posts: parsed.posts });
      }
      index.upsertPosts(entry.threadId, pages);
      result.threadsUpdated++;
      result.postPagesFetched += pages.length;
    } catch (error) {
      if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) result.timeBudgetReached = true;
      result.errors.push({ url: entry.url, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
