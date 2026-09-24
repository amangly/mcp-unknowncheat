import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { load } from "cheerio";
import { navigateWithRetry } from "../browser.js";
import { fetchHtml } from "../crawl.js";
import { isLoggedIn } from "../auth.js";
import { searchViaSubforums } from "../search-fallback.js";

const UC_HOME = "https://www.unknowncheats.me/forum/";
const UC_SEARCH = "https://www.unknowncheats.me/forum/search.php";

function parseThreadList(html: string) {
  const $ = load(html);
  const results: Array<{
    title: string;
    url: string;
    threadId: string;
    author?: string;
    date?: string;
    replies?: number;
    views?: number;
    subforum?: string;
    snippet?: string;
  }> = [];

  $("a[id^='thread_title_']").each((_, el) => {
    const link = $(el);
    const title = link.text().trim();
    const href = link.attr("href") ?? "";
    const id = (link.attr("id") ?? "").replace("thread_title_", "");
    if (!title || !href) return;

    const url = href.startsWith("http") ? href : `https://www.unknowncheats.me${href.startsWith("/") ? "" : "/"}${href}`;

    const row = link.closest("tr, div[id^='threadbit'], li[id^='thread_']");

    const author = row.find(".threadstarterinfo a, a.username, .username").first().text().trim();
    const date = row.find(".threadlastpost .date, .time, .date").first().text().trim();
    const subforum = row.find("a[href*='forumdisplay'], .forumtitle").first().text().trim();

    const cells = row.find("td");
    let replies = 0;
    let views = 0;
    cells.each((_, td) => {
      const text = $(td).text().trim();
      const replyMatch = text.match(/(\d[\d,]*)\s*(?:Repl|repl)/);
      const viewMatch = text.match(/(\d[\d,]*)\s*(?:View|view)/);
      if (replyMatch) replies = parseInt(replyMatch[1].replace(/,/g, ""), 10);
      if (viewMatch) views = parseInt(viewMatch[1].replace(/,/g, ""), 10);
    });
    if (replies === 0 && views === 0) {
      const nums: number[] = [];
      cells.each((_, td) => {
        const text = $(td).text().trim().replace(/,/g, "");
        if (/^\d+$/.test(text)) nums.push(parseInt(text, 10));
      });
      if (nums.length >= 2) {
        replies = nums[nums.length - 2];
        views = nums[nums.length - 1];
      }
    }

    const snippet = row.find(".threadpreview, .searchresult_text, .smallfont:not(:has(a))").first().text().trim().slice(0, 200) || undefined;

    results.push({ title, url, threadId: id, author: author || undefined, date: date || undefined, replies, views, subforum: subforum || undefined, snippet });
  });

  return results;
}

function filterByQuery<T extends { title: string; snippet?: string }>(results: T[], query: string): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return results;

  return results.filter((result) => {
    const haystack = `${result.title} ${result.snippet ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

async function runFallbackSearch(query: string) {
  console.error(`[search] Not logged in — scanning UC subforums for "${query}"`);
  const { results, scannedSubforums } = await searchViaSubforums(query, (url) => fetchHtml(url));

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
    "Search the UnknownCheats forum. Uses advanced search when logged in; falls back to web search when guest. Can also browse subforums directly.",
    {
      query: z.string().describe("Search query string"),
      subforum: z.string().optional().describe("Subforum slug to browse directly (e.g. 'apex-legends')"),
      title_only: z.boolean().optional().default(true).describe("Search only in thread titles (default true, more accurate)"),
      sort_by: z.enum(["relevancy", "lastpost", "replycount", "views", "threadstart"]).optional().default("relevancy").describe("Sort results by"),
      search_user: z.string().optional().describe("Filter by thread author username"),
    },
    async ({ query, subforum, title_only, sort_by, search_user }) => {
      try {
        if (subforum) {
          const url = `https://www.unknowncheats.me/forum/${subforum}/`;
          const html = await fetchHtml(url);
          const results = filterByQuery(parseThreadList(html), query);
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

          searchForm.submit();
          return { ok: true };
        }, { query, titleOnly: title_only, sortBy: sort_by, searchUser: search_user ?? "" });

        if (!submitted.ok) {
          const payload = await runFallbackSearch(query);
          return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
          };
        }

        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {}),
        ]);
        await new Promise((r) => setTimeout(r, 2_000));

        const html = await page.content();
        const results = parseThreadList(html);
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
    }
  );
}
