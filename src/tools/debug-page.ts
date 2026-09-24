import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { load } from "cheerio";
import { navigateWithRetry } from "../browser.js";

export function registerDebugPage(server: McpServer): void {
  server.tool(
    "debug_page",
    "Fetch a page and return its HTML snippet + key element selectors for debugging",
    {
      url: z.string().url().describe("URL to inspect"),
      selector: z.string().optional().describe("CSS selector to extract (returns matched outerHTML)"),
    },
    async ({ url, selector }) => {
      try {
        const { html } = await navigateWithRetry(url);
        const $ = load(html);

        if (selector) {
          const matched: string[] = [];
          $(selector)
            .slice(0, 5)
            .each((_, el) => {
              matched.push($.html(el)?.slice(0, 500) ?? "");
            });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ selector, count: $(selector).length, samples: matched }),
              },
            ],
          };
        }

        // Return structural overview: tag names + classes of top-level body children
        const structure: string[] = [];
        $("body")
          .children()
          .slice(0, 30)
          .each((_, el) => {
            const e = $(el);
            const id = e.attr("id") ? `#${e.attr("id")}` : "";
            const cls = e.attr("class")
              ? "." +
                e
                  .attr("class")!
                  .trim()
                  .split(/\s+/)
                  .slice(0, 3)
                  .join(".")
              : "";
            structure.push(`<${el.tagName}${id}${cls}>`);
          });

        // Also grab title and first post candidate
        const titleCandidates = [
          { sel: "h1", text: $("h1").first().text().trim() },
          { sel: ".threadtitle", text: $(".threadtitle").first().text().trim() },
          { sel: "#pagetitle", text: $("#pagetitle").first().text().trim() },
          { sel: "title", text: $("title").first().text().trim() },
        ];

        const postCandidates = [
          { sel: ".postcontainer", count: $(".postcontainer").length },
          { sel: ".postbitlegacy", count: $(".postbitlegacy").length },
          { sel: "li[id^='post_']", count: $("li[id^='post_']").length },
          { sel: "div[id^='post_']", count: $("div[id^='post_']").length },
          { sel: ".message", count: $(".message").length },
          { sel: "article", count: $("article").length },
          { sel: ".post", count: $(".post").length },
          { sel: "td.alt1", count: $("td.alt1").length },
        ];

        const paginationCandidates = [
          { sel: ".pagination", html: $(".pagination").first().html()?.slice(0, 300) },
          { sel: ".pagenav", html: $(".pagenav").first().html()?.slice(0, 300) },
          { sel: "nav", html: $("nav").first().html()?.slice(0, 300) },
        ];

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { structure, titleCandidates, postCandidates, paginationCandidates },
                null,
                2
              ),
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
