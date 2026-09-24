import { load } from "cheerio";

export interface Subforum {
  slug: string;
  label: string;
  url: string;
  description?: string;
  threadCount?: number;
  postCount?: number;
}

export function parseSubforums(html: string): Subforum[] {
  const $ = load(html);
  const map = new Map<string, Subforum>();

  $("a[href*='/forum/']").each((_, el) => {
    const link = $(el);
    const href = (link.attr("href") ?? "").trim().replace(/^\/\//, "https://");
    const match = href.match(/\/forum\/([a-z0-9][a-z0-9-]{1,})\/?(?:$|[?#])/i);
    if (!match) return;

    const slug = match[1].toLowerCase();
    if (slug.endsWith(".php") || ["forum", "index", "portal", "downloads", "search", "misc", "usercp"].includes(slug)) return;

    const label = link.text().trim();
    if (!label || label.length > 80 || map.has(slug)) return;

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
