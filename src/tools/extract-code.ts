import { withBrowserSession } from "../browser.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchHtml } from "../crawl.js";
import { parseCodeBlocks } from "../parsers/code-blocks.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const MAX_CODE_LENGTH = 3_000;
const EXPORT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "exports");

export function registerExtractCode(server: McpServer): void {
  server.tool(
    "extract_code",
    "Extract and identify code blocks from a thread. Detects C++, C#, Python, and Lua. Use export_to_file=true to save all blocks to a JSON file when there are many code blocks.",
    {
      url: z.string().url().describe("Thread URL to extract code from"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max number of code blocks to return inline (default 10, max 50). Ignored when export_to_file is true."),
      export_to_file: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, exports ALL code blocks to a JSON file instead of returning them inline. Recommended when a page has many code blocks."),
    },
    async ({ url, limit, export_to_file }) => withBrowserSession(async () => {
      try {
        const html = await fetchHtml(url);
        const all = parseCodeBlocks(html);

        if (all.length === 0) {
          return {
            content: [{ type: "text", text: JSON.stringify({ total: 0, returned: 0, blocks: [] }) }],
          };
        }

        if (export_to_file) {
          // Export all blocks (no truncation) to a timestamped file
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const slug = url.split("/").filter(Boolean).pop()?.replace(/\.\w+$/, "") ?? "thread";
          const filePath = `${EXPORT_DIR}/${slug}_${timestamp}.json`;

          const payload = {
            url,
            exported_at: new Date().toISOString(),
            total: all.length,
            blocks: all,
          };

          await mkdir(EXPORT_DIR, { recursive: true });
          await Bun.write(filePath, JSON.stringify(payload, null, 2));

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                total: all.length,
                exported_to: filePath,
                message: `All ${all.length} code blocks exported to ${filePath}`,
              }),
            }],
          };
        }

        // Inline mode: apply limit + truncation
        const sliced = all.slice(0, limit);
        const truncated = all.length > limit;
        const lastPostId = truncated ? (sliced[sliced.length - 1].postId ?? null) : null;

        const blocks = sliced.map((b) => ({
          ...b,
          code:
            b.code.length > MAX_CODE_LENGTH
              ? b.code.slice(0, MAX_CODE_LENGTH) + `\n... [truncated, ${b.code.length} chars total]`
              : b.code,
        }));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              total: all.length,
              returned: blocks.length,
              truncated,
              ...(truncated && {
                hint: `${all.length - limit} blocks not shown. Use export_to_file=true to get all, or increase limit (max 50).`,
                last_post_id: lastPostId,
              }),
              blocks,
            }),
          }],
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
