import { load } from "cheerio";

export type FallbackSearchResult = {
  title: string;
  url: string;
  threadId: string;
  author?: string;
  date?: string;
  replies?: number;
  views?: number;
  subforum?: string;
  snippet?: string;
};

type ThreadListResult = FallbackSearchResult;

function parseThreadList(html: string): ThreadListResult[] {
  const $ = load(html);
  const results: ThreadListResult[] = [];

  $("a[id^='thread_title_']").each((_, el) => {
    const link = $(el);
    const title = link.text().trim();
    const href = link.attr("href") ?? "";
    const id = (link.attr("id") ?? "").replace("thread_title_", "");
    if (!title || !href) return;

    const url = href.startsWith("http")
      ? href
      : `https://www.unknowncheats.me${href.startsWith("/") ? "" : "/"}${href}`;

    const row = link.closest("tr, div[id^='threadbit'], li[id^='thread_']");
    const date = row.find(".threadlastpost .date, .time, .date").first().text().trim();
    const subforum = row.find("a[href*='forumdisplay'], .forumtitle").first().text().trim();
    const snippet = row.find(".threadpreview, .searchresult_text, .smallfont:not(:has(a))").first().text().trim().slice(0, 200) || undefined;

    results.push({
      title,
      url,
      threadId: id,
      date: date || undefined,
      subforum: subforum || undefined,
      snippet,
    });
  });

  return results;
}

function filterByQuery(results: ThreadListResult[], query: string): ThreadListResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return results;

  return results.filter((result) => {
    const haystack = `${result.title} ${result.snippet ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function discoverSubforumSlugs(html: string): Array<{ slug: string; label: string }> {
  const $ = load(html);
  const slugs = new Map<string, string>();

  $("a[href*='/forum/']").each((_, el) => {
    const href = ($(el).attr("href") ?? "").replace(/^\/\//, "https://");
    const match = href.match(/\/forum\/([a-z0-9][a-z0-9-]{1,})\/?(?:$|[?#])/i);
    if (!match) return;

    const slug = match[1].toLowerCase();
    if (slug.endsWith(".php") || slug === "forum" || slug === "index") return;

    const label = $(el).text().trim() || slug;
    if (!slugs.has(slug)) slugs.set(slug, label);
  });

  return [...slugs.entries()].map(([slug, label]) => ({ slug, label }));
}

export function rankSubforums(
  subforums: Array<{ slug: string; label: string }>,
  query: string
): Array<{ slug: string; label: string; score: number }> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const slugGuess = query.trim().toLowerCase().replace(/\s+/g, "-");

  const ranked = subforums.map((entry) => {
    const haystack = `${entry.slug} ${entry.label}`.toLowerCase();
    let score = terms.filter((term) => haystack.includes(term)).length;
    if (entry.slug === slugGuess) score += 10;
    if (entry.slug.includes(slugGuess) || slugGuess.includes(entry.slug)) score += 3;
    return { ...entry, score };
  });

  return ranked.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
}

export async function searchViaSubforums(
  query: string,
  fetchHtml: (url: string) => Promise<string>
): Promise<{ results: FallbackSearchResult[]; scannedSubforums: string[] }> {
  const indexHtml = await fetchHtml("https://www.unknowncheats.me/forum/index.php");
  const subforums = discoverSubforumSlugs(indexHtml);
  const ranked = rankSubforums(subforums, query);

  const candidates = ranked.length > 0
    ? ranked.slice(0, 3)
    : [{ slug: query.trim().toLowerCase().replace(/\s+/g, "-"), label: query, score: 1 }];

  const seen = new Set<string>();
  const results: FallbackSearchResult[] = [];
  const scannedSubforums: string[] = [];

  for (const candidate of candidates) {
    const url = `https://www.unknowncheats.me/forum/${candidate.slug}/`;
    let html: string;

    try {
      html = await fetchHtml(url);
    } catch {
      continue;
    }

    scannedSubforums.push(candidate.slug);
    const threads = filterByQuery(parseThreadList(html), query);

    for (const thread of threads) {
      if (seen.has(thread.url)) continue;
      seen.add(thread.url);
      results.push({
        ...thread,
        subforum: thread.subforum ?? candidate.label,
      });
    }
  }

  return { results, scannedSubforums };
}
