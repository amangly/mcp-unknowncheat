import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { load } from "cheerio";
import { fetchHtml } from "../crawl.js";
import { validateUrl } from "../browser.js";

function extractStat(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern);
  return match ? match[1].trim() : undefined;
}

function parseNumber(text?: string): number | null {
  if (!text) return null;
  const n = parseInt(text.replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

export function registerGetUserReputation(server: McpServer): void {
  server.tool(
    "get_user_reputation",
    "Get an UnknownCheats user's reputation, rep power, join date, post count, and tier from their profile page.",
    {
      profile_url: z
        .string()
        .url()
        .optional()
        .describe("Full user profile URL, e.g. https://www.unknowncheats.me/forum/members/6719713.html"),
      user_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Numeric UC user ID (alternative to profile_url)"),
    },
    async ({ profile_url, user_id }) => {
      try {
        const url = profile_url ?? (user_id
          ? `https://www.unknowncheats.me/forum/members/${user_id}.html`
          : undefined);
        if (!url) {
          return {
            content: [{ type: "text", text: "Error: provide either profile_url or user_id." }],
            isError: true,
          };
        }
        validateUrl(url);

        const html = await fetchHtml(url);
        const $ = load(html);

        const rawTitle = $("title").text().trim();
        const username = $("h1").first().text().trim().split(/\s+/)[0] ||
          rawTitle.replace(/^View Profile:\s*/i, "").split("-")[0].trim();

        const bodyText = $("body").text();

        const reputationText = extractStat(bodyText, /Reputation[:\s]+([-\d,]+)/i);
        const repPowerText = extractStat(bodyText, /Rep\s*Power[:\s]+([-\d,]+)/i);
        const postsText = extractStat(bodyText, /(?:Total Posts|Posts)[:\s]+([\d,]+)/i);
        const joinText = extractStat(bodyText, /(?:Join Date|Joined)[:\s]+([\w\s,-]{4,25}?)(?=\s{2,}|\n|$)/i);
        const location = extractStat(bodyText, /Location[:\s]+([^\n]{1,60})/i);

        const repDot = $("img[src*='reputation_']").first();
        const repDescription = repDot.attr("alt")?.trim();
        const repSrc = repDot.attr("src") ?? "";
        const sign =
          repSrc.includes("_neg") ? "negative" :
          repSrc.includes("_bar") ? "neutral" :
          repSrc.includes("_pos") || repSrc.includes("_highpos") ? "positive" :
          "unknown";

        const reputation = parseNumber(reputationText);
        const repPower = parseNumber(repPowerText);
        const posts = parseNumber(postsText);

        let tier: string;
        if (sign === "negative") tier = "negative";
        else if (reputation === null) tier = "unknown";
        else if (reputation >= 5_000) tier = "legend";
        else if (reputation >= 2_000) tier = "excellent";
        else if (reputation >= 1_000) tier = "great";
        else if (reputation >= 500) tier = "good";
        else if (reputation >= 100) tier = "average";
        else if (reputation >= 10) tier = "positive";
        else if (reputation > 0) tier = "novice";
        else tier = "neutral";

        const trustScore = sign === "negative"
          ? 5
          : reputation === null
            ? 15
            : reputation <= 0
              ? 20
              : Math.max(15, Math.min(100, Math.round(Math.log10(reputation + 1) * 20)));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                url,
                username,
                reputation,
                repPower,
                posts,
                joinDate: joinText,
                location,
                tier,
                sign,
                description: repDescription,
                trustScore,
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
