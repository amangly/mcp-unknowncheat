import { withBrowserSession } from "../browser.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { navigateWithRetry, validateUrl } from "../browser.js";
import { FORUM_INDEX, readForumCatalog, saveForumCatalog, type ForumCatalog } from "../forum-catalog.js";
import type { Subforum } from "../parsers/subforums.js";
import { parseThreadList, parsePaginationInfo } from "../parsers/thread-list.js";
import { parseThread } from "../parsers/thread.js";
import { containsOffsetUpdate, normalizeName, rankGameForums, rankOffsetThreads, rankSharedForumOffsetThreads, type OffsetThread } from "../offset-discovery.js";
import { getForumIndex } from "../forum-index.js";
import { normalizeThreadUrl } from "../forum-url.js";
import { searchNativeThreads } from "../forum-search.js";

const MAX_LISTING_PAGES = 10;
const MAX_THREAD_PAGES = 50;
type ForumPage = Awaited<ReturnType<typeof navigateWithRetry>>["page"];

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

export function registerFindLatestOffsets(server: McpServer): void {
  server.tool(
    "find_latest_offsets",
    "Use when asked for the newest game offsets on UnknownCheats. Discover the game's offsets thread from live listings, then scan from its last page backward for the newest matching post; this does not verify the offsets against a game build.",
    {
      game: z.string().min(1).describe("Game name, such as Apex Legends or PUBG"),
      subforum_slug: z.string().optional().describe("Exact subforum slug from list_subforums when needed"),
      thread_url: z.string().url().optional().describe("Exact UnknownCheats thread URL, skipping forum and thread discovery"),
      max_listing_pages: z.number().int().min(1).max(MAX_LISTING_PAGES).optional().default(5).describe("Maximum game-forum listing pages to inspect"),
      max_thread_pages: z.number().int().min(1).max(MAX_THREAD_PAGES).optional().default(20).describe("Maximum recent thread pages to inspect"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async ({ game, subforum_slug, thread_url, max_listing_pages, max_thread_pages }) => withBrowserSession(async () => {
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
        let selectedUrl = thread_url;
        let selectedTitle: string | undefined;
        let discoveredAt: string | undefined;

        if (!selectedUrl) {
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
          selectedUrl = selected.url;
          selectedTitle = selected.title;
          discoveredAt = selected.listingPage;
        }

        const first = entry ?? await readPage(browserPage!, selectedUrl, deadlineAt);
        browserPage = first.page;
        const thread = parseThread(first.html, selectedUrl);
        selectedTitle ??= thread.title;
        if (thread.posts.length === 0) throw new Error(`No posts parsed from ${selectedUrl}`);
        const pagesScanned: number[] = [];
        const oldestPage = Math.max(1, thread.totalPages - max_thread_pages + 1);

        for (let number = thread.totalPages; number >= oldestPage; number--) {
          if (Date.now() >= deadlineAt) break;
          const url = withPage(selectedUrl, number);
          const response: { page: ForumPage; html: string } = number === 1 && thread.totalPages === 1 ? first : await readPage(browserPage!, url, deadlineAt);
          browserPage = response.page;
          const parsed = parseThread(response.html, url, number);
          const posts = parsed.posts;
          if (posts.length === 0) throw new Error(`No posts parsed from ${url}`);
          getForumIndex().recordThreadPage(parsed, number);
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
          found: false, reason: Date.now() >= deadlineAt ? "time_budget_reached" : "no_offset_update_in_scanned_pages", game, forum,
          forumIndex: catalog ? { url: FORUM_INDEX, indexedAt: catalog.indexedAt, fromCache } : undefined,
          thread: { title: selectedTitle, url: selectedUrl, discoveredAt }, candidateThreads: candidates,
          listingPagesScanned, totalThreadPages: thread.totalPages, pagesScanned,
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
