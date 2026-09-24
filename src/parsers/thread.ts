import { load } from "cheerio";
import type { ThreadData, ThreadPost } from "../types.js";
import { parseReputationInPost } from "./reputation.js";

function parseTotalPages($: ReturnType<typeof load>): number {
  // .pagenav contains "Page X of Y"
  const navText = $(".pagenav").text();
  const match = navText.match(/Page\s+\d+\s+of\s+(\d+)/i);
  if (match) return parseInt(match[1], 10);
  return 1;
}

function parseTitle($: ReturnType<typeof load>): string {
  const raw = $("title").first().text().trim();
  // Strip trailing " - Page N" and site suffix " - unknowncheats.me"
  return raw
    .replace(/\s*-\s*unknowncheats\.me\s*$/i, "")
    .replace(/\s*-\s*Page\s+\d+\s*$/i, "")
    .trim() || "Unknown Thread";
}

export function parseThread(html: string, url: string, pageNum = 1): ThreadData {
  const $ = load(html);

  const title = parseTitle($);
  const totalPages = parseTotalPages($);
  const posts: ThreadPost[] = [];

  // Each post is wrapped in table[id^='post'] where id is purely numeric (e.g. post4638271)
  $("table[id]").each((_, el) => {
    const tableEl = $(el);
    const idAttr = tableEl.attr("id") ?? "";

    // Only match post tables: id starts with 'post' followed by digits only (not 'post_message_')
    if (!/^post\d+$/.test(idAttr)) return;

    const postId = parseInt(idAttr.replace("post", ""), 10);

    // Author: a.bigusername inside this post table
    const author = tableEl.find("a.bigusername").first().text().trim();

    // Reputation lives inside the left postbit cell (td.alt2)
    const postbitCell = tableEl.find("td.alt2").first();
    const reputation = postbitCell.length > 0 ? parseReputationInPost($, postbitCell) : undefined;

    // Date: first td.thead text (strip whitespace and img alt text)
    const dateRaw = tableEl.find("td.thead").first().clone();
    dateRaw.find("img, a").remove();
    const date = dateRaw.text().trim().replace(/\s+/g, " ");

    // Content: div#post_message_NNNNN
    const contentEl = tableEl.find(`div[id='post_message_${postId}']`).clone();
    // Remove quoted blocks
    contentEl.find("div[style*='margin']").has("div.smallfont").remove();
    const content = contentEl.text().trim().replace(/\s+/g, " ");

    // Extract links
    const links: { text: string; url: string }[] = [];
    contentEl.find("a[href]").each((_, a) => {
      const href = $(a).attr("href") ?? "";
      const text = $(a).text().trim();
      if (href && !href.startsWith("#")) {
        const url = href.startsWith("http") ? href : `https://www.unknowncheats.me${href}`;
        links.push({ text: text || url, url });
      }
    });

    // Extract images
    const images: string[] = [];
    contentEl.find("img[src]").each((_, img) => {
      const src = $(img).attr("src") ?? "";
      if (src && !src.includes("clear.gif") && !src.includes("spacer") && !src.includes("wol_error") && !src.includes("statusicon")) {
        const url = src.startsWith("http") ? src : `https://www.unknowncheats.me${src}`;
        images.push(url);
      }
    });

    if (author || content) {
      posts.push({ author, date, content, postNumber: postId, links, images, reputation });
    }
  });

  return { title, tags: [], posts, currentPage: pageNum, totalPages, url };
}
