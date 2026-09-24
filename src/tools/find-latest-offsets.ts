import { withBrowserSession } from "../browser.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { navigateWithRetry, validateUrl } from "../browser.js";
import { FORUM_INDEX, readForumCatalog, saveForumCatalog, type ForumCatalog } from "../forum-catalog.js";
import type { Subforum } from "../parsers/subforums.js";
import { parseThreadList, parsePaginationInfo } from "../parsers/thread-list.js";
import { parseThread } from "../parsers/thread.js";
import { containsOffsetUpdate, matchesSharedForumQuery, normalizeName, postsWithCodeBlocks, rankGameForums, rankOffsetThreads, rankSharedForumOffsetThreads, type OffsetThread } from "../offset-discovery.js";
import { parseCodeBlocks } from "../parsers/code-blocks.js";
import { getForumIndex } from "../forum-index.js";
import { normalizeThreadUrl } from "../forum-url.js";
import { searchNativeThreads } from "../forum-search.js";
import { DEFAULT_RECENT_PAGES, recentPageNumbers } from "../thread-pages.js";
import type { ThreadPost } from "../types.js";

const MAX_LISTING_PAGES = 10;
const MAX_THREAD_PAGES = 50;
const MAX_CANDIDATE_THREADS = 5;
type ForumPage = Awaited<ReturnType<typeof navigateWithRetry>>["page"];

interface OffsetScan {
  title: string;
  url: string;
  discoveredAt?: string;
  totalPages: number;
  pagesScanned: number[];
  recentPagesRequested: number[];
  recentPagesComplete: boolean;
  match?: { post: ThreadPost; sourcePage: string };
}

function withPage(url: string, page: number): string {
  const target = new URL(url);
  target.searchParams.set("page", String(page));
  return target.toString();
}

async function readPage(page: ForumPage, url: string, deadlineAt: number): Promise<{ page: ForumPage; html: string }> {
  validateUrl(url);
  if (Date.now() >= deadlineAt) throw new Error("Offsets lookup time budget exhausted");
  try {
    const response = await page.evaluate(async ({ target, timeoutMs }) => {
      const result = await fetch(target, { credentials: "include", signal: AbortSignal.timeout(timeoutMs) });
      return { ok: result.ok, url: result.url, html: await result.text() };
    }, { target: url, timeoutMs: Math.max(1, Math.min(8_000, deadlineAt - Date.now())) });
    validateUrl(response.url);
    if (!response.ok || /Just a moment|cf-browser-verification|Checking your browser/i.test(response.html)) {
      throw new Error("Forum returned a challenge or an error");
    }
    return { page, html: response.html };
  } catch {
    return navigateWithRetry(url, deadlineAt);
  }
}

async function scanThread(
  browserPage: ForumPage | null,
  target: { url: string; title?: string; discoveredAt?: string },
  firstResponse: { page: ForumPage; html: string } | null,
  game: string,
  checkQuery: boolean,
  maxThreadPages: number,
  deadlineAt: number,
): Promise<{ page: ForumPage; scan: OffsetScan }> {
  const first = firstResponse ?? (browserPage
    ? await readPage(browserPage, target.url, deadlineAt)
    : await navigateWithRetry(target.url, deadlineAt));
  let currentPage: ForumPage = first.page;
  const thread = parseThread(first.html, target.url);
  if (thread.posts.length === 0) throw new Error(`No posts parsed from ${target.url}`);
  const pagesScanned: number[] = [];
  const recentPagesRequested = recentPageNumbers(thread.totalPages, Math.min(DEFAULT_RECENT_PAGES, maxThreadPages));
  const oldestPage = Math.max(1, thread.totalPages - maxThreadPages + 1);
  let match: OffsetScan["match"];

  for (let number = thread.totalPages; number >= oldestPage; number--) {
    if (Date.now() >= deadlineAt) break;
    const url = withPage(target.url, number);
    const response = number === 1 && thread.totalPages === 1 ? first : await readPage(currentPage, url, deadlineAt);
    currentPage = response.page;
    const parsed = parseThread(response.html, url, number);
    if (parsed.posts.length === 0) throw new Error(`No posts parsed from ${url}`);
    getForumIndex().recordThreadPage(parsed, number);
    pagesScanned.push(number);
    const posts = postsWithCodeBlocks(parsed.posts, parseCodeBlocks(response.html));
    const newestOnPage = posts.reverse().find((post) =>
      containsOffsetUpdate(post) && (!checkQuery || matchesSharedForumQuery(game, thread.title, post.content)));
    if (newestOnPage && !match) match = { post: newestOnPage, sourcePage: url };
    if (match && recentPagesRequested.every((pageNum) => pagesScanned.includes(pageNum))) break;
  }

  return { page: currentPage, scan: {
    title: target.title ?? thread.title,
    url: target.url,
    discoveredAt: target.discoveredAt,
    totalPages: thread.totalPages,
    pagesScanned,
    recentPagesRequested,
    recentPagesComplete: recentPagesRequested.every((pageNum) => pagesScanned.includes(pageNum)),
    match,
  } };
}

export function registerFindLatestOffsets(server: McpServer): void {
  server.tool(
    "find_latest_offsets",
    "Use when asked for the newest game offsets on UnknownCheats. Compare the latest 3 pages of plausible candidate threads before returning a match; this does not verify offsets against a game build.",
    {
      game: z.string().min(1).describe("Game name, such as Apex Legends or PUBG"),
      subforum_slug: z.string().optional().describe("Exact subforum slug from list_subforums when needed"),
      thread_url: z.string().url().optional().describe("Exact UnknownCheats thread URL, skipping forum and thread discovery"),
      max_listing_pages: z.number().int().min(1).max(MAX_LISTING_PAGES).optional().default(5).describe("Maximum game-forum listing pages to inspect"),
      max_thread_pages: z.number().int().min(1).max(MAX_THREAD_PAGES).optional().default(DEFAULT_RECENT_PAGES).describe("Maximum recent thread pages to inspect (default 3; increase to search farther back)"),
      max_candidate_threads: z.number().int().min(1).max(MAX_CANDIDATE_THREADS).optional().default(3).describe("Maximum plausible offset threads to compare (default 3)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async ({ game, subforum_slug, thread_url, max_listing_pages, max_thread_pages, max_candidate_threads }) => withBrowserSession(async () => {
      const deadlineAt = Date.now() + 45_000;
      try {
        if (thread_url) thread_url = normalizeThreadUrl(thread_url);
        if (thread_url) validateUrl(thread_url);
        const entry = thread_url ? await navigateWithRetry(thread_url, deadlineAt) : null;
        let browserPage: ForumPage | null = entry?.page ?? null;
        let catalog: ForumCatalog | null = null;
        let fromCache = false;
        let forum: Subforum | null = null;
        let forumChoices: Subforum[] = [];
        const listingPagesScanned: string[] = [];
        let candidates: OffsetThread[] = [];

        if (!thread_url) {
          catalog = await readForumCatalog();
          fromCache = catalog !== null;
          if (!catalog) {
            try {
              const index = await navigateWithRetry(FORUM_INDEX, deadlineAt);
              browserPage = index.page;
              catalog = await saveForumCatalog(index.html);
            } catch (error) {
              console.error("[offsets] Forum directory unavailable; checking indexed threads:", error);
            }
          }
          let forums = catalog?.subforums ?? [];
          forumChoices = rankGameForums(game, forums);
          forum = subforum_slug ? forums.find((item) => item.slug === subforum_slug) ?? null : forumChoices[0] ?? null;
          if (!forum && fromCache) {
            try {
              const index = await navigateWithRetry(FORUM_INDEX, deadlineAt);
              browserPage = index.page;
              catalog = await saveForumCatalog(index.html);
              fromCache = false;
              forums = catalog.subforums;
              forumChoices = rankGameForums(game, forums);
              forum = subforum_slug ? forums.find((item) => item.slug === subforum_slug) ?? null : forumChoices[0] ?? null;
            } catch (error) {
              console.error("[offsets] Forum directory refresh failed; checking indexed threads:", error);
            }
          }
          if (!forum && subforum_slug) {
            return { content: [{ type: "text", text: JSON.stringify({
              found: false, reason: "game_forum_not_found", game,
              forumIndex: catalog ? { url: FORUM_INDEX, indexedAt: catalog.indexedAt, fromCache } : undefined, candidateForums: forumChoices.slice(0, 10),
            }) }] };
          }
          if (forum && !subforum_slug &&
              normalizeName(forum.label) !== normalizeName(game) &&
              normalizeName(forum.slug) !== normalizeName(game)) {
            return { content: [{ type: "text", text: JSON.stringify({
              found: false, reason: "ambiguous_game_forum", game,
              forumIndex: catalog ? { url: FORUM_INDEX, indexedAt: catalog.indexedAt, fromCache } : undefined, candidateForums: forumChoices.slice(0, 10),
            }) }] };
          }

          if (forum) {
            for (let number = 1; number <= max_listing_pages; number++) {
              if (Date.now() >= deadlineAt) break;
              const url = number === 1 ? forum.url : `${forum.url}index${number}.html`;
              const response = browserPage ? await readPage(browserPage, url, deadlineAt) : await navigateWithRetry(url, deadlineAt);
              browserPage = response.page;
              listingPagesScanned.push(url);
              const threads = parseThreadList(response.html);
              if (threads.length === 0) throw new Error(`No thread list parsed from ${url}`);
              getForumIndex().recordListing(forum.slug, number, threads);
              candidates.push(...rankOffsetThreads(threads, url));
              if (candidates.length > 0 || number >= parsePaginationInfo(response.html).totalPages) break;
            }
          } else {
            const baseGame = normalizeName(game).replace(/\b(?:cn|chinese|wegame)\b/g, "").trim();
            const indexed = getForumIndex().search(baseGame, undefined, 100)
              .filter((hit) => hit.kind === "thread")
              .map((hit) => ({ ...hit, replies: 0, views: 0, isSticky: false }));
            candidates = rankSharedForumOffsetThreads(game, indexed, "local_index");
            if (candidates.length === 0) {
              const query = `${baseGame} offsets`;
              const search = await searchNativeThreads(query, true, "relevancy", "", deadlineAt);
              listingPagesScanned.push(search.resultsUrl);
              candidates = rankSharedForumOffsetThreads(game, search.results, search.resultsUrl);
            }
          }

          candidates = [...new Map(candidates.map((item) => [item.url, item])).values()]
            .sort((a, b) => b.score - a.score || b.replies - a.replies)
            .slice(0, 10);
          const selected = candidates[0];
          if (!selected) {
            return { content: [{ type: "text", text: JSON.stringify({
              found: false, reason: Date.now() >= deadlineAt ? "time_budget_reached" : forum ? "offset_thread_not_found_in_scanned_listings" : "offset_thread_not_found_in_search", game, forum,
              forumIndex: catalog ? { url: FORUM_INDEX, indexedAt: catalog.indexedAt, fromCache } : undefined, listingPagesScanned,
            }) }] };
          }
        }

        const targets = thread_url
          ? [{ url: thread_url }]
          : candidates.slice(0, max_candidate_threads).map((candidate) => ({
            url: candidate.url, title: candidate.title, discoveredAt: candidate.listingPage,
          }));
        const scans: OffsetScan[] = [];
        const errors: Array<{ url: string; error: string }> = [];
        for (const target of targets) {
          if (Date.now() >= deadlineAt) break;
          try {
            const result = await scanThread(
              browserPage, target, target.url === thread_url ? entry : null,
              game, !forum && !thread_url, max_thread_pages, deadlineAt,
            );
            browserPage = result.page;
            scans.push(result.scan);
          } catch (error) {
            errors.push({ url: target.url, error: error instanceof Error ? error.message : String(error) });
          }
        }
        const best = scans.filter((scan) => scan.match)
          .sort((a, b) => b.match!.post.postNumber - a.match!.post.postNumber)[0];
        const candidateScanIncomplete = candidates.length > targets.length || targets.length !== scans.length ||
          scans.some((scan) => !scan.recentPagesComplete);
        const discoveryIncomplete = !thread_url;
        const incomplete = candidateScanIncomplete || discoveryIncomplete;

        if (best?.match) {
          const { post, sourcePage } = best.match;
          return { content: [{ type: "text", text: JSON.stringify({
            found: true, game, forum, candidateForums: forumChoices.slice(0, 5),
            forumIndex: catalog ? { url: FORUM_INDEX, indexedAt: catalog.indexedAt, fromCache } : undefined,
            thread: { title: best.title, url: best.url, discoveredAt: best.discoveredAt }, candidateThreads: candidates,
            listingPagesScanned, totalThreadPages: best.totalPages, pagesScanned: best.pagesScanned,
            recentPagesRequested: best.recentPagesRequested, recentPagesComplete: best.recentPagesComplete,
            scannedThreads: scans.map(({ match, ...scan }) => ({ ...scan, matchedPostNumber: match?.post.postNumber })),
            errors, candidateScanIncomplete, discoveryIncomplete, incomplete,
            sourcePage, sourcePost: `${sourcePage}#post${post.postNumber}`,
            checkedAt: new Date().toISOString(),
            post: { date: post.date, author: post.author, postNumber: post.postNumber, content: post.content.slice(0, 2_000), links: post.links },
            note: "Newest matching post by post ID among scanned candidates. Unscanned threads and game-version validity are unverified.",
          }) }] };
        }

        return { content: [{ type: "text", text: JSON.stringify({
          found: false, reason: Date.now() >= deadlineAt ? "time_budget_reached" : scans.length === 0 ? "candidate_scans_failed" : "no_offset_update_in_scanned_pages", game, forum,
          forumIndex: catalog ? { url: FORUM_INDEX, indexedAt: catalog.indexedAt, fromCache } : undefined,
          candidateThreads: candidates, listingPagesScanned,
          scannedThreads: scans.map(({ match, ...scan }) => scan), errors,
          candidateScanIncomplete, discoveryIncomplete, incomplete,
          checkedAt: new Date().toISOString(),
        }) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (Date.now() >= deadlineAt) {
          return { content: [{ type: "text", text: JSON.stringify({
            found: false, reason: "time_budget_reached", game, thread_url,
            checkedAt: new Date().toISOString(), error: message,
          }) }] };
        }
        return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
      }
    })
  );
}
