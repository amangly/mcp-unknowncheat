import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchHtml } from "../crawl.js";
import { FORUM_INDEX, readForumCatalog, saveForumCatalog } from "../forum-catalog.js";

export function registerListSubforums(server: McpServer): void {
  server.tool(
    "list_subforums",
    "List game subforum URLs discovered from the live UnknownCheats index. The local directory expires after 24 hours.",
    {
      query: z.string().optional().describe("Optional keyword to filter subforum slugs/labels/descriptions"),
      limit: z.number().int().min(1).max(500).optional().default(100).describe("Max subforums returned (default 100)"),
      refresh: z.boolean().optional().default(false).describe("Fetch the forum index again instead of using the local directory"),
    },
    async ({ query, limit, refresh }) => {
      try {
        const cached = refresh ? null : await readForumCatalog();
        const catalog = cached ?? await saveForumCatalog(await fetchHtml(FORUM_INDEX, { bypassCache: refresh }));
        const all = catalog.subforums;

        const filtered = query
          ? all.filter((sf) => {
              const haystack = `${sf.slug} ${sf.label} ${sf.description ?? ""}`.toLowerCase();
              return query
                .toLowerCase()
                .split(/\s+/)
                .filter(Boolean)
                .every((term) => haystack.includes(term));
            })
          : all;

        const capped = filtered.slice(0, limit);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                total: all.length,
                matched: filtered.length,
                returned: capped.length,
                source: catalog.source,
                indexedAt: catalog.indexedAt,
                fromCache: Boolean(cached),
                subforums: capped,
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
    }
  );
}
