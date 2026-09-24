import { withBrowserSession } from "../browser.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchHtml } from "../crawl.js";
import { isLoggedIn } from "../auth.js";
import { searchViaSubforums } from "../search-fallback.js";
import { filterThreads, parseThreadList } from "../parsers/thread-list.js";
import { FORUM_INDEX, readForumCatalog, saveForumCatalog } from "../forum-catalog.js";
import { getForumIndex } from "../forum-index.js";
import { searchNativeThreads } from "../forum-search.js";

const UC_HOME = "https://www.unknowncheats.me/forum/";

async function runFallbackSearch(query: string) {
  console.error(`[search] Native search unavailable — checking the local index and subforums for "${query}"`);
  const index = getForumIndex();
  const indexedQuery = /\b(?:cn|chinese)\b/i.test(query)
    ? query.replace(/\b(?:cn|chinese)\b/gi, "WeGame")
    : query;
  const hits = index.search(indexedQuery, undefined, 20).filter((hit) => hit.kind === "thread");
  if (hits.length > 0) {
    return {
      count: hits.length,
      source: "local_index" as const,
      incomplete: true,
      coverage: index.status(),
      requiresLoginForNativeSearch: true,
      hint: "These indexed listings may be stale. Open a thread to verify it live.",
      results: hits,
    };
  }
  const catalog = await readForumCatalog() ?? await saveForumCatalog(await fetchHtml(FORUM_INDEX));
  const { results, scannedSubforums } = await searchViaSubforums(query, async (url) => {
    const html = await fetchHtml(url);
    const slug = new URL(url).pathname.match(/^\/forum\/([a-z0-9-]+)\/$/)?.[1];
    if (slug) {
      const entries = parseThreadList(html);
      if (entries.length > 0) getForumIndex().recordListing(slug, 1, entries);
    }
    return html;
  }, catalog.subforums);

  return {
    count: results.length,
    source: "subforum_scan" as const,
    incomplete: true,
    scannedSubforums,
    requiresLoginForNativeSearch: true,
    hint: results.length === 0
      ? scannedSubforums.length === 0
        ? "No matching subforum was found. Log in for full UC search or pass an exact subforum slug."
        : "No matches in scanned subforums. Pass subforum (e.g. apex-legends) or use the login tool for full UC search."
      : "Use the login tool for full UC advanced search (filters, sort, author).",
    results,
  };
}

export function registerSearchForum(server: McpServer): void {
  server.tool(
    "search_forum",
    "Use for live UnknownCheats evidence when a user asks about game hacking, cheats, anti-cheat, reversing, offsets, or a forum thread. Uses advanced search when logged in, scans relevant subforums as a guest, or browses a named subforum.",
    {
      query: z.string().optional().default("").describe("Search query string; optional when browsing a subforum"),
      subforum: z.string().optional().describe("Subforum slug to browse directly (e.g. 'apex-legends')"),
      title_only: z.boolean().optional().default(true).describe("Search only in thread titles (default true, more accurate)"),
      sort_by: z.enum(["relevancy", "lastpost", "replycount", "views", "threadstart"]).optional().default("relevancy").describe("Sort results by"),
      search_user: z.string().optional().describe("Filter by thread author username"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async ({ query, subforum, title_only, sort_by, search_user }) => withBrowserSession(async () => {
      try {
        if (!subforum && !query.trim()) {
          return {
            content: [{ type: "text", text: "Provide query or subforum" }],
            isError: true,
          };
        }

        if (subforum) {
          const url = `https://www.unknowncheats.me/forum/${subforum}/`;
          const html = await fetchHtml(url);
          const entries = parseThreadList(html);
          if (entries.length > 0) getForumIndex().recordListing(subforum, 1, entries);
          const results = filterThreads(entries, { query, includeSticky: true });
          return {
            content: [{ type: "text", text: JSON.stringify({ count: results.length, subforum, results }) }],
          };
        }

        const homeHtml = await fetchHtml(UC_HOME);
        if (!isLoggedIn(homeHtml)) {
          const payload = await runFallbackSearch(query);
          return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
          };
        }

        const { results, pageTitle, pagination } = await searchNativeThreads(query, title_only, sort_by, search_user ?? "");

        console.error(`[search] "${query}" → ${results.length} results, page: ${pageTitle}`);

        return {
          content: [{ type: "text", text: JSON.stringify({ count: results.length, source: "unknowncheats", pageTitle, pagination, results }) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          const payload = await runFallbackSearch(query);
          return {
            content: [{ type: "text", text: JSON.stringify({ ...payload, nativeSearchError: message }) }],
          };
        } catch (fallbackErr) {
          const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          return {
            content: [{ type: "text", text: `Error: ${message} (fallback also failed: ${fallbackMessage})` }],
            isError: true,
          };
        }
      }
    })
  );
}
