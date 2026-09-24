import { withBrowserSession } from "../browser.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchHtml } from "../crawl.js";
import { parseThread } from "../parsers/thread.js";
import { getForumIndex } from "../forum-index.js";
import type { ThreadPost } from "../types.js";
import { normalizeThreadUrl } from "../forum-url.js";

const MAX_PAGES = 50;
const MAX_IMAGES = 10; // max images to fetch and embed per call

function buildPageUrl(baseUrl: string, page: number): string {
  const url = new URL(baseUrl);
  url.searchParams.set("page", String(page));
  return url.toString();
}

async function fetchImageAsBase64(url: string, deadlineAt: number): Promise<{ data: string; mimeType: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(Math.max(1, Math.min(8_000, deadlineAt - Date.now()))),
    });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") ?? "image/png";
    const mimeType = contentType.split(";")[0].trim();
    if (!mimeType.startsWith("image/")) return null;

    const buffer = await res.arrayBuffer();
    const data = Buffer.from(buffer).toString("base64");
    return { data, mimeType };
  } catch {
    return null;
  }
}

export function registerGetThread(server: McpServer): void {
  server.tool(
    "get_thread",
    "Read the source UnknownCheats thread behind a game hacking or offset claim. Use latest_pages for recent posts in long-running threads; the default reads only the linked page.",
    {
      url: z.string().url().describe("Thread URL"),
      fetch_all_pages: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, fetches all pages of the thread (max 50 pages)"),
      latest_pages: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("Read the last 1-5 pages. Takes precedence over fetch_all_pages."),
      include_images: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, fetches post images and returns them as viewable image content (max 10 images)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async ({ url, fetch_all_pages, latest_pages, include_images }) => withBrowserSession(async () => {
      try {
        url = normalizeThreadUrl(url);
        const deadlineAt = Date.now() + 45_000;
        const firstHtml = await fetchHtml(url, { deadlineAt });
        const pageParam = Number(new URL(url).searchParams.get("page"));
        const requestedPage = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;
        const firstPage = parseThread(firstHtml, url, requestedPage);
        if (firstPage.posts.length === 0) throw new Error(`No thread posts found at ${url} (page title: ${firstPage.title})`);
        const totalPages = firstPage.totalPages;
        const pagesToFetch = latest_pages
          ? Array.from({ length: Math.min(latest_pages, totalPages) }, (_, index) =>
              totalPages - Math.min(latest_pages, totalPages) + index + 1)
          : fetch_all_pages
            ? Array.from({ length: Math.min(totalPages, MAX_PAGES) }, (_, index) => index + 1)
            : [Math.min(requestedPage, totalPages)];

        const allPosts: ThreadPost[] = [];
        const pagesFetched: number[] = [];
        let timeBudgetReached = false;
        for (const pageNum of pagesToFetch) {
          if (pageNum !== requestedPage && Date.now() >= deadlineAt) {
            timeBudgetReached = true;
            break;
          }
          const pageUrl = buildPageUrl(url, pageNum);
          let html: string;
          try {
            html = pageNum === requestedPage ? firstHtml : await fetchHtml(pageUrl, { deadlineAt });
          } catch (error) {
            if (Date.now() < deadlineAt) throw error;
            timeBudgetReached = true;
            break;
          }
          const parsed = parseThread(html, pageUrl, pageNum);
          allPosts.push(...parsed.posts);
          getForumIndex().recordThreadPage(parsed, pageNum);
          pagesFetched.push(pageNum);
          console.error(`[get-thread] Fetched page ${pageNum}/${totalPages}`);
        }
        if (pagesFetched.length === 0 && firstPage.posts.length > 0) {
          allPosts.push(...firstPage.posts);
          pagesFetched.push(requestedPage);
          getForumIndex().recordThreadPage(firstPage, requestedPage);
        }

        const result = {
          title: firstPage.title,
          posts: allPosts,
          currentPage: pagesFetched.at(-1),
          pagesFetched,
          totalPages,
          url,
          timeBudgetReached,
          ...(fetch_all_pages && !latest_pages && totalPages > MAX_PAGES
            ? { note: `Capped at ${MAX_PAGES} pages (thread has ${totalPages} total)` }
            : {}),
        };

        // Build content array
        const content: Array<
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        > = [];

        if (include_images) {
          // Collect all unique image URLs from all posts
          const seen = new Set<string>();
          const imageUrls: string[] = [];

          for (const post of allPosts) {
            for (const imgUrl of post.images) {
              if (!seen.has(imgUrl)) {
                seen.add(imgUrl);
                imageUrls.push(imgUrl);
              }
              if (imageUrls.length >= MAX_IMAGES) break;
            }
            if (imageUrls.length >= MAX_IMAGES) break;
          }

          console.error(`[get-thread] Fetching ${imageUrls.length} images...`);

          for (const imgUrl of imageUrls) {
            if (Date.now() >= deadlineAt) {
              result.timeBudgetReached = true;
              break;
            }
            const img = await fetchImageAsBase64(imgUrl, deadlineAt);
            if (img) {
              content.push({ type: "image", data: img.data, mimeType: img.mimeType });
              console.error(`[get-thread] Fetched image: ${imgUrl}`);
            }
          }
        }

        if (include_images && Date.now() >= deadlineAt) result.timeBudgetReached = true;
        content.unshift({ type: "text", text: JSON.stringify(result) });

        return { content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
      }
    })
  );
}
