import { withBrowserSession } from "../browser.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchHtml } from "../crawl.js";
import { getForumIndex } from "../forum-index.js";
import {
  filterThreads,
  parsePaginationInfo,
  parseThreadList,
  type ThreadListEntry,
} from "../parsers/thread-list.js";

const HARD_PAGE_CAP = 30;

function buildPageUrl(subforum: string, page: number): string {
  const base = `https://www.unknowncheats.me/forum/${subforum}/`;
  if (page <= 1) return base;
  return `${base}index${page}.html`;
}

export function registerCrawlSubforum(server: McpServer): void {
  server.tool(
    "crawl_subforum",
    "Walk multiple pages of a subforum thread listing with filters (query, min_replies, min_views, author, prefix). Great for building a corpus of relevant threads.",
    {
      subforum: z.string().describe("Subforum slug (e.g. 'apex-legends'). Use list_subforums to discover."),
      max_pages: z
        .number()
        .int()
        .min(1)
        .max(HARD_PAGE_CAP)
        .optional()
        .default(3)
        .describe(`How many pages of the subforum to walk (max ${HARD_PAGE_CAP}, default 3)`),
      query: z.string().optional().describe("Optional keyword filter on title/snippet (AND semantics)"),
      min_replies: z.number().int().min(0).optional().describe("Only include threads with at least this many replies"),
      min_views: z.number().int().min(0).optional().describe("Only include threads with at least this many views"),
      author: z.string().optional().describe("Only include threads by this author (case-insensitive substring)"),
      prefix: z.string().optional().describe("Only include threads with this prefix label"),
      include_sticky: z.boolean().optional().default(false).describe("Include sticky/announcement threads (default false)"),
      sort_by: z
        .enum(["default", "replies", "views", "title"])
        .optional()
        .default("default")
        .describe("Sort the collected results locally"),
      limit: z.number().int().min(1).max(500).optional().default(100).describe("Max threads returned after filtering/sorting"),
    },
    async ({ subforum, max_pages, query, min_replies, min_views, author, prefix, include_sticky, sort_by, limit }) => withBrowserSession(async () => {
      try {
        const deadlineAt = Date.now() + 45_000;
        let timeBudgetReached = false;
        const pagesWalked: number[] = [];
        const collected: ThreadListEntry[] = [];
        const seen = new Set<string>();
        let totalPagesAvailable = 1;

        for (let page = 1; page <= max_pages; page++) {
          if (Date.now() >= deadlineAt) {
            timeBudgetReached = true;
            break;
          }
          const url = buildPageUrl(subforum, page);
          let html: string;
          try {
            html = await fetchHtml(url, { deadlineAt });
          } catch (err) {
            if (Date.now() >= deadlineAt) timeBudgetReached = true;
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[crawl-subforum] Failed page ${page}: ${message}`);
            break;
          }

          const pageInfo = parsePaginationInfo(html);
          totalPagesAvailable = pageInfo.totalPages;
          pagesWalked.push(page);

          const threads = parseThreadList(html);
          if (threads.length > 0) getForumIndex().recordListing(subforum, page, threads);
          for (const thread of threads) {
            if (seen.has(thread.url)) continue;
            seen.add(thread.url);
            collected.push(thread);
          }

          if (page >= totalPagesAvailable) break;
        }

        const filtered = filterThreads(collected, {
          query,
          minReplies: min_replies,
          minViews: min_views,
          author,
          prefix,
          includeSticky: include_sticky,
        });

        const sorted = [...filtered];
        if (sort_by === "replies") sorted.sort((a, b) => b.replies - a.replies);
        else if (sort_by === "views") sorted.sort((a, b) => b.views - a.views);
        else if (sort_by === "title") sorted.sort((a, b) => a.title.localeCompare(b.title));

        const capped = sorted.slice(0, limit);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                subforum,
                pagesWalked,
                timeBudgetReached,
                totalPagesAvailable,
                collected: collected.length,
                matched: filtered.length,
                returned: capped.length,
                filter: {
                  query,
                  min_replies,
                  min_views,
                  author,
                  prefix,
                  include_sticky,
                  sort_by,
                },
                results: capped,
              }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
      }
    })
  );
}
