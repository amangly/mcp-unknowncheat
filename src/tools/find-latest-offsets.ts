import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { navigateWithRetry, validateUrl } from "../browser.js";
import { FORUM_INDEX, readForumCatalog, saveForumCatalog, type ForumCatalog } from "../forum-catalog.js";
import type { Subforum } from "../parsers/subforums.js";
import { parseThreadList, parsePaginationInfo } from "../parsers/thread-list.js";
import { parseThread } from "../parsers/thread.js";
import { containsOffsetUpdate, normalizeName, rankGameForums, rankOffsetThreads, type OffsetThread } from "../offset-discovery.js";

const MAX_LISTING_PAGES = 10;
const MAX_THREAD_PAGES = 50;
type ForumPage = Awaited<ReturnType<typeof navigateWithRetry>>["page"];

function withPage(url: string, page: number): string {
  const target = new URL(url);
  target.searchParams.set("page", String(page));
  return target.toString();
}

async function readPage(page: ForumPage, url: string): Promise<{ page: ForumPage; html: string }> {
  validateUrl(url);
  try {
    const response = await page.evaluate(async (target) => {
      const result = await fetch(target, { credentials: "include", signal: AbortSignal.timeout(8_000) });
      return { ok: result.ok, url: result.url, html: await result.text() };
    }, url);
    validateUrl(response.url);
    if (!response.ok || /Just a moment|cf-browser-verification|Checking your browser/i.test(response.html)) {
      throw new Error("Forum returned a challenge or an error");
    }
    return { page, html: response.html };
  } catch {
    return navigateWithRetry(url);
  }
}

export function registerFindLatestOffsets(server: McpServer): void {
  server.tool(
    "find_latest_offsets",
    "Discover a game's offsets thread from live UnknownCheats forum listings, then scan from its last page backward for the newest matching post.",
    {
      game: z.string().min(1).describe("Game name, such as Apex Legends or PUBG"),
      subforum_slug: z.string().optional().describe("Exact subforum slug from list_subforums when needed"),
      thread_url: z.string().url().optional().describe("Exact UnknownCheats thread URL, skipping forum and thread discovery"),
      max_listing_pages: z.number().int().min(1).max(MAX_LISTING_PAGES).optional().default(5).describe("Maximum game-forum listing pages to inspect"),
      max_thread_pages: z.number().int().min(1).max(MAX_THREAD_PAGES).optional().default(20).describe("Maximum recent thread pages to inspect"),
    },
    async ({ game, subforum_slug, thread_url, max_listing_pages, max_thread_pages }) => {
      try {
        if (thread_url) validateUrl(thread_url);
        const entry = thread_url ? await navigateWithRetry(thread_url) : null;
        let browserPage: ForumPage | null = entry?.page ?? null;
        let catalog: ForumCatalog | null = null;
        let fromCache = false;
        let forum: Subforum | null = null;
        let forumChoices: Subforum[] = [];
        const listingPagesScanned: string[] = [];
        let candidates: OffsetThread[] = [];
        let selectedUrl = thread_url;
        let selectedTitle: string | undefined;
        let discoveredAt: string | undefined;

        if (!selectedUrl) {
          catalog = await readForumCatalog();
          fromCache = catalog !== null;
          if (!catalog) {
            const index = await navigateWithRetry(FORUM_INDEX);
            browserPage = index.page;
            catalog = await saveForumCatalog(index.html);
          }
          let forums = catalog.subforums;
          forumChoices = rankGameForums(game, forums);
          forum = subforum_slug ? forums.find((item) => item.slug === subforum_slug) ?? null : forumChoices[0] ?? null;
          if (!forum && fromCache) {
            const index = await navigateWithRetry(FORUM_INDEX);
            browserPage = index.page;
            catalog = await saveForumCatalog(index.html);
            fromCache = false;
            forums = catalog.subforums;
            forumChoices = rankGameForums(game, forums);
            forum = subforum_slug ? forums.find((item) => item.slug === subforum_slug) ?? null : forumChoices[0] ?? null;
          }
          if (!forum) {
            return { content: [{ type: "text", text: JSON.stringify({
              found: false, reason: "game_forum_not_found", game,
              forumIndex: { url: FORUM_INDEX, indexedAt: catalog.indexedAt, fromCache }, candidateForums: forumChoices.slice(0, 10),
            }) }] };
          }
          if (!subforum_slug &&
              normalizeName(forum.label) !== normalizeName(game) &&
              normalizeName(forum.slug) !== normalizeName(game)) {
            return { content: [{ type: "text", text: JSON.stringify({
              found: false, reason: "ambiguous_game_forum", game,
              forumIndex: { url: FORUM_INDEX, indexedAt: catalog.indexedAt, fromCache }, candidateForums: forumChoices.slice(0, 10),
            }) }] };
          }

          for (let number = 1; number <= max_listing_pages; number++) {
            const url = number === 1 ? forum.url : `${forum.url}index${number}.html`;
            const response = browserPage ? await readPage(browserPage, url) : await navigateWithRetry(url);
            browserPage = response.page;
            listingPagesScanned.push(url);
            const threads = parseThreadList(response.html);
            if (threads.length === 0) throw new Error(`No thread list parsed from ${url}`);
            candidates.push(...rankOffsetThreads(threads, url));
            if (candidates.length > 0 || number >= parsePaginationInfo(response.html).totalPages) break;
          }

          candidates = [...new Map(candidates.map((item) => [item.url, item])).values()]
            .sort((a, b) => b.score - a.score || b.replies - a.replies)
            .slice(0, 10);
          const selected = candidates[0];
          if (!selected) {
            return { content: [{ type: "text", text: JSON.stringify({
              found: false, reason: "offset_thread_not_found_in_scanned_listings", game, forum,
              forumIndex: { url: FORUM_INDEX, indexedAt: catalog.indexedAt, fromCache }, listingPagesScanned,
            }) }] };
          }
          selectedUrl = selected.url;
          selectedTitle = selected.title;
          discoveredAt = selected.listingPage;
        }

        const first = entry ?? await readPage(browserPage!, selectedUrl);
        browserPage = first.page;
        const thread = parseThread(first.html, selectedUrl);
        selectedTitle ??= thread.title;
        if (thread.posts.length === 0) throw new Error(`No posts parsed from ${selectedUrl}`);
        const pagesScanned: number[] = [];
        const oldestPage = Math.max(1, thread.totalPages - max_thread_pages + 1);

        for (let number = thread.totalPages; number >= oldestPage; number--) {
          const url = withPage(selectedUrl, number);
          const response: { page: ForumPage; html: string } = number === 1 && thread.totalPages === 1 ? first : await readPage(browserPage!, url);
          browserPage = response.page;
          const posts = parseThread(response.html, url, number).posts;
          if (posts.length === 0) throw new Error(`No posts parsed from ${url}`);
          pagesScanned.push(number);
          const match = posts.reverse().find(containsOffsetUpdate);
          if (match) {
            return { content: [{ type: "text", text: JSON.stringify({
              found: true, game, forum, candidateForums: forumChoices.slice(0, 5),
              forumIndex: catalog ? { url: FORUM_INDEX, indexedAt: catalog.indexedAt, fromCache } : undefined,
              thread: { title: selectedTitle, url: selectedUrl, discoveredAt }, candidateThreads: candidates,
              listingPagesScanned, totalThreadPages: thread.totalPages, pagesScanned,
              sourcePage: url, sourcePost: `${url}#post${match.postNumber}`,
              checkedAt: new Date().toISOString(),
              post: { date: match.date, author: match.author, postNumber: match.postNumber, content: match.content.slice(0, 2_000), links: match.links },
              note: "Newest matching post in the scanned pages. Linked data and game-version validity are unverified.",
            }) }] };
          }
        }

        return { content: [{ type: "text", text: JSON.stringify({
          found: false, reason: "no_offset_update_in_scanned_pages", game, forum,
          forumIndex: catalog ? { url: FORUM_INDEX, indexedAt: catalog.indexedAt, fromCache } : undefined,
          thread: { title: selectedTitle, url: selectedUrl, discoveredAt }, candidateThreads: candidates,
          listingPagesScanned, totalThreadPages: thread.totalPages, pagesScanned,
          checkedAt: new Date().toISOString(),
        }) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
      }
    }
  );
}
