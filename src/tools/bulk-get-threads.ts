import { withBrowserSession } from "../browser.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchHtml } from "../crawl.js";
import { parseThread } from "../parsers/thread.js";
import { parseCodeBlocks } from "../parsers/code-blocks.js";
import { validateUrl } from "../browser.js";
import { getForumIndex } from "../forum-index.js";
import type { ThreadPost } from "../types.js";
import type { AuthorReputation } from "../parsers/reputation.js";

const MAX_URLS = 20;
const MAX_PAGES_PER_THREAD = 10;
const MAX_CONTENT_CHARS_PER_POST = 4_000;
const MAX_CODE_CHARS = 3_000;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... [truncated, ${text.length} chars total]`;
}

function buildPageUrl(baseUrl: string, page: number): string {
  const url = new URL(baseUrl);
  url.searchParams.set("page", String(page));
  return url.toString();
}

interface AuthorAgg {
  author: string;
  bestReputation: AuthorReputation | null;
  postCount: number;
  hasNegative: boolean;
}

function aggregateAuthors(posts: ThreadPost[]): AuthorAgg[] {
  const map = new Map<string, AuthorAgg>();

  for (const post of posts) {
    if (!post.author) continue;
    const existing = map.get(post.author) ?? {
      author: post.author,
      bestReputation: null,
      postCount: 0,
      hasNegative: false,
    };
    existing.postCount += 1;

    const rep = post.reputation ?? null;
    if (rep) {
      if (rep.negativeDots > 0 || rep.sign === "negative") existing.hasNegative = true;
      if (!existing.bestReputation || (rep.trustScore > existing.bestReputation.trustScore)) {
        existing.bestReputation = rep;
      }
    }

    map.set(post.author, existing);
  }

  return [...map.values()].sort((a, b) => {
    const at = a.bestReputation?.trustScore ?? 0;
    const bt = b.bestReputation?.trustScore ?? 0;
    return bt - at;
  });
}

export function registerBulkGetThreads(server: McpServer): void {
  server.tool(
    "bulk_get_threads",
    "Fetch multiple UC threads (cached + rate-limited). Includes author reputation, trust scores, and OP-rep filters so untrustworthy threads can be skipped.",
    {
      urls: z
        .array(z.string().url())
        .min(1)
        .max(MAX_URLS)
        .describe(`Thread URLs to fetch (max ${MAX_URLS})`),
      include_posts: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include post content (default true). Set false for a summary-only crawl."),
      include_code: z
        .boolean()
        .optional()
        .default(true)
        .describe("Extract code blocks per thread (default true)"),
      code_limit_per_thread: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .default(5)
        .describe("Max code blocks returned per thread (default 5)"),
      fetch_all_pages: z
        .boolean()
        .optional()
        .default(false)
        .describe(`If true, fetch every page of each thread (cap ${MAX_PAGES_PER_THREAD})`),
      post_content_chars: z
        .number()
        .int()
        .min(200)
        .max(20_000)
        .optional()
        .default(MAX_CONTENT_CHARS_PER_POST)
        .describe("Max characters of body text kept per post"),
      min_op_rep: z
        .number()
        .int()
        .optional()
        .describe("Skip threads whose original poster has reputation below this value"),
      exclude_negative_op: z
        .boolean()
        .optional()
        .default(false)
        .describe("Skip threads whose original poster has any negative-rep dot"),
      min_op_trust: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe("Skip threads whose OP trust score (0-100) is below this"),
    },
    async ({
      urls,
      include_posts,
      include_code,
      code_limit_per_thread,
      fetch_all_pages,
      post_content_chars,
      min_op_rep,
      exclude_negative_op,
      min_op_trust,
    }) => withBrowserSession(async () => {
      const results: unknown[] = [];
      const skipped: Array<{ url: string; reason: string; opAuthor?: string; opReputation?: AuthorReputation }> = [];
      let successCount = 0;
      let errorCount = 0;
      let processed = 0;
      let timeBudgetReached = false;
      const deadlineAt = Date.now() + 45_000;

      for (const url of urls) {
        if (Date.now() >= deadlineAt) {
          timeBudgetReached = true;
          break;
        }
        processed++;
        try {
          validateUrl(url);

          const firstHtml = await fetchHtml(url, { deadlineAt });
          const first = parseThread(firstHtml, url, 1);
          getForumIndex().recordThreadPage(first, 1);
          const opPost = first.posts[0];
          const opRep = opPost?.reputation ?? null;

          if (opRep) {
            if (exclude_negative_op && (opRep.negativeDots > 0 || opRep.sign === "negative")) {
              skipped.push({
                url,
                reason: "OP has negative reputation",
                opAuthor: opPost?.author,
                opReputation: opRep,
              });
              continue;
            }
            if (min_op_rep !== undefined && (opRep.score ?? 0) < min_op_rep) {
              skipped.push({
                url,
                reason: `OP rep ${opRep.score ?? "unknown"} < min_op_rep ${min_op_rep}`,
                opAuthor: opPost?.author,
                opReputation: opRep,
              });
              continue;
            }
            if (min_op_trust !== undefined && opRep.trustScore < min_op_trust) {
              skipped.push({
                url,
                reason: `OP trustScore ${opRep.trustScore} < min_op_trust ${min_op_trust}`,
                opAuthor: opPost?.author,
                opReputation: opRep,
              });
              continue;
            }
          }

          let allPosts: ThreadPost[] = [...first.posts];
          const pagesFetched: number[] = [1];

          if (fetch_all_pages && first.totalPages > 1) {
            const limit = Math.min(first.totalPages, MAX_PAGES_PER_THREAD);
            for (let pageNum = 2; pageNum <= limit; pageNum++) {
              if (Date.now() >= deadlineAt) {
                timeBudgetReached = true;
                break;
              }
              const pageUrl = buildPageUrl(url, pageNum);
              try {
                const pageHtml = await fetchHtml(pageUrl, { deadlineAt });
                const parsed = parseThread(pageHtml, pageUrl, pageNum);
                getForumIndex().recordThreadPage(parsed, pageNum);
                allPosts.push(...parsed.posts);
                pagesFetched.push(pageNum);
              } catch (pageErr) {
                if (Date.now() >= deadlineAt) timeBudgetReached = true;
                console.error(`[bulk] Page ${pageNum} of ${url} failed:`, pageErr);
                break;
              }
            }
          }

          const authors = aggregateAuthors(allPosts);

          const threadResult: Record<string, unknown> = {
            url,
            title: first.title,
            currentPagesFetched: pagesFetched,
            totalPages: first.totalPages,
            postCount: allPosts.length,
            op: opPost
              ? {
                  author: opPost.author,
                  date: opPost.date,
                  reputation: opRep,
                }
              : null,
            authorScoring: {
              uniqueAuthors: authors.length,
              topAuthors: authors.slice(0, 5).map((a) => ({
                author: a.author,
                postCount: a.postCount,
                trustScore: a.bestReputation?.trustScore ?? 0,
                tier: a.bestReputation?.tier ?? "unknown",
                sign: a.bestReputation?.sign ?? "unknown",
                score: a.bestReputation?.score ?? null,
                description: a.bestReputation?.description,
              })),
              flaggedAuthors: authors.filter((a) => a.hasNegative).map((a) => a.author),
            },
          };

          if (include_posts) {
            threadResult.posts = allPosts.map((post) => ({
              author: post.author,
              date: post.date,
              postNumber: post.postNumber,
              content: truncate(post.content, post_content_chars),
              linkCount: post.links.length,
              imageCount: post.images.length,
              reputation: post.reputation
                ? {
                    score: post.reputation.score,
                    power: post.reputation.power,
                    sign: post.reputation.sign,
                    tier: post.reputation.tier,
                    trustScore: post.reputation.trustScore,
                    description: post.reputation.description,
                    positiveDots: post.reputation.positiveDots,
                    highPositiveDots: post.reputation.highPositiveDots,
                    negativeDots: post.reputation.negativeDots,
                  }
                : null,
            }));
          }

          if (include_code) {
            const codeBlocks = parseCodeBlocks(firstHtml)
              .slice(0, code_limit_per_thread)
              .map((block) => ({
                ...block,
                code: truncate(block.code, MAX_CODE_CHARS),
              }));
            threadResult.codeBlocks = codeBlocks;
            threadResult.codeBlockCount = codeBlocks.length;
          }

          results.push(threadResult);
          successCount++;
        } catch (err) {
          if (Date.now() >= deadlineAt) timeBudgetReached = true;
          const message = err instanceof Error ? err.message : String(err);
          results.push({ url, error: message });
          errorCount++;
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              requested: urls.length,
              succeeded: successCount,
              failed: errorCount,
              timeBudgetReached,
              remainingUrls: urls.slice(processed),
              skipped: skipped.length,
              skippedDetail: skipped,
              threads: results,
            }),
          },
        ],
      };
    })
  );
}
