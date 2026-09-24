import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { clearCache, getCacheStats } from "../crawl.js";

export function registerCacheControl(server: McpServer): void {
  server.tool(
    "crawl_cache",
    "Inspect or clear the in-memory HTML cache used by crawler tools.",
    {
      action: z.enum(["stats", "clear"]).default("stats").describe("'stats' to inspect, 'clear' to purge"),
    },
    async ({ action }) => {
      if (action === "clear") {
        const removed = clearCache();
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, removed }) }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(getCacheStats()) }],
      };
    }
  );
}
