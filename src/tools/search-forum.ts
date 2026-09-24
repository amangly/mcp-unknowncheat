import { withBrowserSession } from "../browser.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { load } from "cheerio";
import { navigateWithRetry } from "../browser.js";
import { fetchHtml } from "../crawl.js";
import { isLoggedIn } from "../auth.js";
import { searchViaSubforums } from "../search-fallback.js";
import { filterThreads, parseThreadList } from "../parsers/thread-list.js";
import { FORUM_INDEX, readForumCatalog, saveForumCatalog } from "../forum-catalog.js";
import { getForumIndex } from "../forum-index.js";

const UC_HOME = "https://www.unknowncheats.me/forum/";
const UC_SEARCH = "https://www.unknowncheats.me/forum/search.php";

async function runFallbackSearch(query: string) {
  console.error(`[search] Not logged in — scanning UC subforums for "${query}"`);
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
    scannedSubforums,
    requiresLoginForNativeSearch: true,
    hint: results.length === 0
      ? "No matches in scanned subforums. Pass subforum (e.g. apex-legends) or use the login tool for full UC search."
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

        const { page } = await navigateWithRetry(UC_SEARCH);

        const submitted = await page.evaluate((opts) => {
          const searchForm = document.getElementById("searchform") as HTMLFormElement | null;
          if (!searchForm) return { ok: false, error: "Advanced search form (#searchform) not found" };

          const queryInput = searchForm.querySelector('input[name="query"][size="35"]') as HTMLInputElement
            ?? searchForm.querySelector('input[name="query"]') as HTMLInputElement;
          if (!queryInput) return { ok: false, error: "Query input not found in form" };
          queryInput.value = opts.query;

          const titleOnlySelect = searchForm.querySelector('select[name="titleonly"]') as HTMLSelectElement;
          if (titleOnlySelect) {
            titleOnlySelect.value = opts.titleOnly ? "1" : "0";
          }

          const showThreads = searchForm.querySelector('input[name="showposts"][value="0"]') as HTMLInputElement;
          if (showThreads) showThreads.checked = true;

          const sortSelect = searchForm.querySelector('select[name="sortby"]') as HTMLSelectElement;
          if (sortSelect) sortSelect.value = opts.sortBy;

          if (opts.searchUser) {
            const userInput = searchForm.querySelector('input[name="searchuser"]') as HTMLInputElement;
            if (userInput) userInput.value = opts.searchUser;
          }

          return { ok: true };
        }, { query, titleOnly: title_only, sortBy: sort_by, searchUser: search_user ?? "" });

        if (!submitted.ok) {
          const payload = await runFallbackSearch(query);
          return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
          };
        }

        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
          page.evaluate(() => (document.getElementById("searchform") as HTMLFormElement).submit()),
        ]);

        const html = await page.content();
        const results = parseThreadList(html);
        if (results.length > 0) getForumIndex().recordSearchResults(results);
        const $ = load(html);
        const pageTitle = $("title").text().trim();

        const errorText = $(".standard_error, .errorwrap, .blockbody .error").first().text().trim();
        if (errorText) {
          return {
            content: [{ type: "text", text: JSON.stringify({ count: 0, error: errorText, pageTitle }) }],
          };
        }

        const pageNav = $(".pagenav td.vbmenu_control").first().text().trim();
        const pageMatch = pageNav.match(/Page (\d+) of (\d+)/);
        const pagination = pageMatch ? { currentPage: parseInt(pageMatch[1]), totalPages: parseInt(pageMatch[2]) } : undefined;

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
