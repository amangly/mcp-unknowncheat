import { load } from "cheerio";
import { filterThreads, parseThreadList, type ThreadListEntry } from "./parsers/thread-list.js";
import { preferredForumSlug } from "./offset-discovery.js";

function discoverSubforumSlugs(html: string): Array<{ slug: string; label: string }> {
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

function rankSubforums(
  subforums: Array<{ slug: string; label: string }>,
  query: string
): Array<{ slug: string; label: string; score: number }> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const slugGuess = query.trim().toLowerCase().replace(/\s+/g, "-");
  const preferredSlug = preferredForumSlug(query);

  const ranked = subforums.map((entry) => {
    const haystack = `${entry.slug} ${entry.label}`.toLowerCase();
    let score = terms.filter((term) => haystack.includes(term)).length;
    if (entry.slug === slugGuess) score += 10;
    if (entry.slug === preferredSlug) score += 20;
    if (entry.slug.includes(slugGuess) || slugGuess.includes(entry.slug)) score += 3;
    return { ...entry, score };
  });

  return ranked.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
}

export async function searchViaSubforums(
  query: string,
  fetchHtml: (url: string) => Promise<string>,
  knownSubforums?: Array<{ slug: string; label: string }>,
): Promise<{ results: ThreadListEntry[]; scannedSubforums: string[] }> {
  const subforums = knownSubforums ?? discoverSubforumSlugs(await fetchHtml("https://www.unknowncheats.me/forum/index.php"));
  const ranked = rankSubforums(subforums, query);

  const candidates = ranked.length > 0
    ? ranked.slice(0, 3)
    : [{ slug: query.trim().toLowerCase().replace(/\s+/g, "-"), label: query, score: 1 }];

  const seen = new Set<string>();
  const results: ThreadListEntry[] = [];
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
    const threads = filterThreads(parseThreadList(html), { query, includeSticky: true });

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
