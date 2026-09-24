import type { Subforum } from "./parsers/subforums.js";
import type { ThreadListEntry } from "./parsers/thread-list.js";
import type { CodeBlock, ThreadPost } from "./types.js";

export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

const GAME_FORUM_ALIASES: Record<string, string> = {
  pubg: "playerunknown-s-battlegrounds",
  "playerunknowns battlegrounds": "playerunknown-s-battlegrounds",
  cs2: "counter-strike-2-a",
  "counter strike 2": "counter-strike-2-a",
  csgo: "counterstrike-global-offensive",
};

export function preferredForumSlug(queryText: string): string | undefined {
  const query = normalizeName(queryText);
  if (query.includes("pubg mobile")) return undefined;
  return Object.entries(GAME_FORUM_ALIASES)
    .sort(([a], [b]) => b.length - a.length)
    .find(([name]) => query === name || query.startsWith(`${name} `) ||
      query.endsWith(` ${name}`) || query.includes(` ${name} `))?.[1];
}

export function rankGameForums(game: string, forums: Subforum[]): Subforum[] {
  const query = normalizeName(game);
  if (!query) return [];
  const alias = preferredForumSlug(game);
  if (alias) {
    const exact = forums.find((forum) => forum.slug === alias);
    if (exact) return [exact];
  }
  const terms = query.split(" ");
  return forums
    .map((forum) => {
      const label = normalizeName(forum.label);
      const slug = normalizeName(forum.slug);
      const score = label === query || slug === query
        ? 100
        : label.startsWith(`${query} `) || slug.startsWith(`${query} `)
          ? 50
          : terms.every((term) => label.split(" ").includes(term) || slug.split(" ").includes(term))
            ? 10
            : 0;
      return { forum, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.forum.label.length - b.forum.label.length)
    .map(({ forum }) => forum);
}

export type OffsetThread = ThreadListEntry & { listingPage: string; score: number };

export function rankOffsetThreads(threads: ThreadListEntry[], listingPage: string): OffsetThread[] {
  return threads
    .map((thread) => {
      const title = thread.title.toLowerCase();
      const score = (/\boffsets?\b/.test(title) ? 5 : 0) +
        (/\breversal\b/.test(title) ? 4 : 0) +
        (/\bstructs?\b/.test(title) ? 2 : 0) +
        (/\b(?:sigs?|signatures?)\b/.test(title) ? 2 : 0);
      return { ...thread, listingPage, score };
    })
    .filter(({ score }) => score >= 4)
    .sort((a, b) => b.score - a.score || b.replies - a.replies);
}

export function rankSharedForumOffsetThreads(game: string, threads: ThreadListEntry[], listingPage: string): OffsetThread[] {
  const normalizedGame = normalizeName(game);
  const wantsCn = /\b(?:cn|chinese|wegame)\b/.test(normalizedGame);
  const gameTerms = normalizedGame.split(" ").filter((term) => !["cn", "chinese", "wegame"].includes(term));
  return rankOffsetThreads(threads, listingPage)
    .filter((thread) => {
      const title = normalizeName(thread.title);
      return gameTerms.every((term) => title.split(" ").includes(term));
    })
    .map((thread) => ({
      ...thread,
      score: thread.score + (wantsCn && /\b(?:cn|chinese|wegame)\b/.test(normalizeName(thread.title)) ? 10 : 0),
    }))
    .sort((a, b) => b.score - a.score || b.replies - a.replies);
}

export function matchesSharedForumQuery(game: string, threadTitle: string, postContent: string): boolean {
  const terms = new Set(normalizeName(`${threadTitle} ${postContent}`).split(" "));
  return normalizeName(game).split(" ").every((term) =>
    ["cn", "chinese", "wegame"].includes(term)
      ? ["cn", "chinese", "wegame"].some((alias) => terms.has(alias))
      : terms.has(term));
}

export function containsOffsetUpdate(post: ThreadPost): boolean {
  const firstValue = post.content.search(/\b0x[0-9a-f]{3,}\b/i);
  const firstLink = post.content.search(/https:\/\/(?:www\.)?(?:pastebin\.com|pastes\.dev)\//i);
  const evidenceAt = [firstValue, firstLink].filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 200;
  const introduction = post.content.slice(0, Math.min(evidenceAt, 200));
  if (/\?|\b(?:anyone|looking for|need|requesting)\b/i.test(introduction)) {
    return false;
  }
  const terms = /\b(offsets?|signatures?|sigs?|dump|patch)\b/i;
  const pasteLink = post.links.some(({ url }) => /^https:\/\/(?:www\.)?(?:pastebin\.com|pastes\.dev)\//i.test(url));
  const hexAssignments = post.content.match(/=\s*0x[0-9a-f]{3,}\b/gi)?.length ?? 0;
  const namedHexValues = post.content.match(/\b[A-Za-z_][A-Za-z0-9_.]{2,}\s*(?::|=|\s+0x)\s*(?:0x)?[0-9a-f]{7,16}\b/gi)?.length ?? 0;
  const colonValues = post.content.match(/\b[A-Za-z_][A-Za-z0-9_.]{2,}\s*:\s*(?:0x)?[0-9a-f]{7,16}\b/gi)?.length ?? 0;
  return (pasteLink && terms.test(post.content)) ||
    (hexAssignments >= 3 && /\boffsets?\s*[:{]|\bconstexpr\b|\b(?:OFF_|dw[A-Z]|m_)/i.test(post.content)) ||
    (namedHexValues >= 2 && (colonValues >= 2 || /\b(?:new|latest|updated|version|offsets|sdk|dump)\b/i.test(post.content)));
}

export function postsWithCodeBlocks(posts: ThreadPost[], blocks: CodeBlock[]): ThreadPost[] {
  const byPost = new Map<string, string[]>();
  for (const block of blocks) {
    if (!block.postId) continue;
    const code = byPost.get(block.postId) ?? [];
    code.push(block.code);
    byPost.set(block.postId, code);
  }
  return posts.map((post) => {
    const code = byPost.get(`post${post.postNumber}`)?.filter((block) => !post.content.includes(block)) ?? [];
    return code.length > 0 ? { ...post, content: `${post.content}\n${code.join("\n")}` } : post;
  });
}
