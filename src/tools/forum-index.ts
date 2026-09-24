import { withBrowserSession } from "../browser.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getForumIndex } from "../forum-index.js";
import { fetchHtml } from "../crawl.js";
import { syncSubforumIndex } from "../sync-index.js";

export function registerForumIndex(server: McpServer): void {
  server.tool(
    "index_subforum",
    "Incrementally index a bounded subforum listing and the first/recent pages of changed threads.",
    {
      subforum: z.string().describe("Exact slug from list_subforums"),
      max_listing_pages: z.number().int().min(1).max(5).optional().default(1),
      max_threads: z.number().int().min(0).max(20).optional().default(5),
      recent_pages: z.number().int().min(1).max(3).optional().default(1),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ subforum, max_listing_pages, max_threads, recent_pages }) => withBrowserSession(async () => {
      try {
        const deadlineAt = Date.now() + 45_000;
        const result = await syncSubforumIndex(getForumIndex(), subforum, {
          maxListingPages: max_listing_pages, maxThreads: max_threads, recentPages: recent_pages,
          deadlineAt,
        }, (url) => fetchHtml(url, { deadlineAt }));
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }),
  );

  server.tool(
    "search_index",
    "Use first for forum-related game hacking, cheat, anti-cheat, reversing, or offsets questions. Search locally indexed thread titles, snippets and sampled post pages without fetching the forum. Results include timestamps and may be partial or stale.",
    {
      query: z.string().min(1),
      subforum: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional().default(20),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ query, subforum, limit }) => {
      try {
        const index = getForumIndex();
        const hits = index.search(query, subforum, limit);
        return { content: [{ type: "text", text: JSON.stringify({ source: "local_index", count: hits.length, coverage: index.status(subforum), hits }) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  );

  server.tool(
    "index_status",
    "Show local index coverage, counts, and last update times; does not contact the forum.",
    { subforum: z.string().optional().describe("Optional subforum slug to inspect indexed listing page numbers") },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ subforum }) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(getForumIndex().status(subforum)) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  );
}
