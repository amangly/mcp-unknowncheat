import { load } from "cheerio";
import { normalizeThreadUrl } from "../forum-url.js";

export interface ThreadListEntry {
  title: string;
  url: string;
  threadId: string;
  author?: string;
  date?: string;
  replies: number;
  views: number;
  subforum?: string;
  snippet?: string;
  isSticky: boolean;
  prefix?: string;
}

export function parseThreadList(html: string): ThreadListEntry[] {
  const $ = load(html);
  const results: ThreadListEntry[] = [];

  $("a[id^='thread_title_']").each((_, el) => {
    const link = $(el);
    const title = link.text().trim();
    const href = link.attr("href") ?? "";
    const id = (link.attr("id") ?? "").replace("thread_title_", "");
    if (!title || !href) return;

    const row = link.closest("tr, div[id^='threadbit'], li[id^='thread_']");

    const author =
      row.find(".threadstarterinfo a, a.username, .username").first().text().trim() ||
      row.find("div.smallfont").eq(0).text().trim() ||
      undefined;

    const date =
      row.find(".threadlastpost .date, .time, .date").first().text().trim() || undefined;

    const subforum =
      row.find("a[href*='forumdisplay'], .forumtitle").first().text().trim() || undefined;

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

    const snippetRaw = row
      .find(".threadpreview, .searchresult_text, .smallfont:not(:has(a))")
      .first()
      .text()
      .trim();
    const snippet = snippetRaw ? snippetRaw.slice(0, 200) : undefined;

    const prefixRaw = row.find(".prefix, .threadprefix").first().text().trim();
    const prefix = prefixRaw || undefined;

    const parent =
      row.parent().attr("id") ??
      row.attr("id") ??
      row.closest("[id]").attr("id") ??
      "";
    const rowClass = row.attr("class") ?? "";
    const rowText = row.text();
    const stickyIconPresent = row.find("img[src*='sticky'], img[alt*='Sticky' i]").length > 0;
    const isSticky =
      /sticky/i.test(parent) ||
      /sticky/i.test(rowClass) ||
      stickyIconPresent ||
      /\bSticky:/i.test(rowText) ||
      snippet?.toLowerCase() === "sticky";

    results.push({
      title,
      url: normalizeThreadUrl(href),
      threadId: id,
      author,
      date,
      replies,
      views,
      subforum,
      snippet,
      isSticky,
      prefix,
    });
  });

  return results;
}

export interface PaginationInfo {
  currentPage: number;
  totalPages: number;
}

export function parsePaginationInfo(html: string): PaginationInfo {
  const $ = load(html);
  const navText = $(".pagenav").first().text().trim();
  const match = navText.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
  if (match) {
    return { currentPage: parseInt(match[1], 10), totalPages: parseInt(match[2], 10) };
  }
  return { currentPage: 1, totalPages: 1 };
}

export interface ThreadFilter {
  query?: string;
  minReplies?: number;
  minViews?: number;
  prefix?: string;
  author?: string;
  includeSticky?: boolean;
}

export function filterThreads(threads: ThreadListEntry[], filter: ThreadFilter): ThreadListEntry[] {
  const terms = filter.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const authorLc = filter.author?.toLowerCase();
  const prefixLc = filter.prefix?.toLowerCase();

  return threads.filter((thread) => {
    if (!filter.includeSticky && thread.isSticky) return false;
    if (filter.minReplies !== undefined && thread.replies < filter.minReplies) return false;
    if (filter.minViews !== undefined && thread.views < filter.minViews) return false;
    if (authorLc && !(thread.author ?? "").toLowerCase().includes(authorLc)) return false;
    if (prefixLc && !(thread.prefix ?? "").toLowerCase().includes(prefixLc)) return false;
    if (terms.length > 0) {
      const haystack = `${thread.title} ${thread.snippet ?? ""}`.toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) return false;
    }
    return true;
  });
}
