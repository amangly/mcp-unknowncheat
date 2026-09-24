import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { load } from "cheerio";
import { fetchHtml } from "../crawl.js";

const UC_INDEX = "https://www.unknowncheats.me/forum/index.php";

interface Subforum {
  slug: string;
  label: string;
  url: string;
  description?: string;
  threadCount?: number;
  postCount?: number;
}

function parseSubforums(html: string): Subforum[] {
  const $ = load(html);
  const map = new Map<string, Subforum>();

  $("a[href*='/forum/']").each((_, el) => {
    const link = $(el);
    const rawHref = (link.attr("href") ?? "").trim();
    if (!rawHref) return;

    const normalized = rawHref.replace(/^\/\//, "https://");
    const match = normalized.match(/\/forum\/([a-z0-9][a-z0-9-]{1,})\/?(?:$|[?#])/i);
    if (!match) return;

    const slug = match[1].toLowerCase();
    if (slug.endsWith(".php") || ["forum", "index", "portal", "downloads", "search", "misc", "usercp"].includes(slug)) return;

    const label = link.text().trim();
    if (!label || label.length > 80) return;

    if (map.has(slug)) return;

    const row = link.closest("tr, li.forumbit_post, .forumbit_nopost");
    const description = row.find(".forumdescription, .smallfont.forumdescription").first().text().trim() || undefined;

    const statText = row.find(".forumstats, td.alt2").text();
    const threadMatch = statText.match(/Threads[:\s]+([\d,]+)/i);
    const postMatch = statText.match(/Posts[:\s]+([\d,]+)/i);

    map.set(slug, {
      slug,
      label,
      url: `https://www.unknowncheats.me/forum/${slug}/`,
      description,
      threadCount: threadMatch ? parseInt(threadMatch[1].replace(/,/g, ""), 10) : undefined,
      postCount: postMatch ? parseInt(postMatch[1].replace(/,/g, ""), 10) : undefined,
    });
  });

  return [...map.values()];
}

export function registerListSubforums(server: McpServer): void {
  server.tool(
    "list_subforums",
    "List UnknownCheats subforums discovered from the forum index. Optionally filter by keyword.",
    {
      query: z.string().optional().describe("Optional keyword to filter subforum slugs/labels/descriptions"),
      limit: z.number().int().min(1).max(500).optional().default(100).describe("Max subforums returned (default 100)"),
    },
    async ({ query, limit }) => {
      try {
        const html = await fetchHtml(UC_INDEX);
        const all = parseSubforums(html);

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
