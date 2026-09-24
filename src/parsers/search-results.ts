import { load } from "cheerio";
import { extractTags } from "./tags.js";
import type { SearchResult } from "../types.js";

const UC_BASE = "https://www.unknowncheats.me";

function toAbsolute(url: string): string {
  if (url.startsWith("http")) return url;
  return UC_BASE + (url.startsWith("/") ? url : "/" + url);
}

function parseCount(text: string): number {
  const n = parseInt(text.replace(/[^0-9]/g, ""), 10);
  return isNaN(n) ? 0 : n;
}

export function parseSearchResults(html: string): SearchResult[] {
  const $ = load(html);
  const results: SearchResult[] = [];

  // vBulletin search results — try multiple selector patterns
  const rows = $(".searchresult, #searchresults .threadbit, li.searchresult, .threadlisthead + tbody tr");

  rows.each((_, el) => {
    const row = $(el);

    // Title + URL
    const titleLink = row.find(".threadtitle a, a.title, td.alt1 a").first();
    const title = titleLink.text().trim();
    const href = titleLink.attr("href") ?? "";
    if (!title || !href) return;

    const url = toAbsolute(href);
    const tags = extractTags($, titleLink);

    const author = row.find(".username, .threadstarterinfo a, .author").first().text().trim();
    const date = row.find(".date, .threadlastpost, .time").first().text().trim();

    const statsText = row.find(".threadstats, .threadcount").text();
    const statNums = statsText.match(/\d+/g) ?? [];
    const replies = parseCount(statNums[0] ?? "0");
    const views = parseCount(statNums[1] ?? "0");

    const subforum = row.find(".forumtitle, .subforumtitle, a[href*='forumdisplay']").first().text().trim();
    const snippet = row.find(".threadpreview, .searchresult_text").first().text().trim();

    results.push({ title, url, author, date, replies, views, subforum, tags, snippet });
  });

  return results;
}
