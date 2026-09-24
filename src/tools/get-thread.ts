import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchHtml } from "../crawl.js";
import { parseThread } from "../parsers/thread.js";
import type { ThreadPost } from "../types.js";

const MAX_PAGES = 50;
const MAX_IMAGES = 10; // max images to fetch and embed per call

function buildPageUrl(baseUrl: string, page: number): string {
  const url = new URL(baseUrl);
  url.searchParams.set("page", String(page));
  return url.toString();
}

async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8_000),
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
    "Get thread content from UnknownCheats. Set fetch_all_pages to true to retrieve all pages.",
    {
      url: z.string().url().describe("Thread URL"),
      fetch_all_pages: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, fetches all pages of the thread (max 50 pages)"),
      include_images: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, fetches post images and returns them as viewable image content (max 10 images)"),
    },
    async ({ url, fetch_all_pages, include_images }) => {
      try {
        const firstHtml = await fetchHtml(url);
        const firstPage = parseThread(firstHtml, url, 1);

        let allPosts: ThreadPost[] = [...firstPage.posts];

        if (fetch_all_pages && firstPage.totalPages > 1) {
          const pagesToFetch = Math.min(firstPage.totalPages, MAX_PAGES);

          for (let pageNum = 2; pageNum <= pagesToFetch; pageNum++) {
            const pageUrl = buildPageUrl(url, pageNum);
            const html = await fetchHtml(pageUrl);
            const parsed = parseThread(html, pageUrl, pageNum);
            allPosts.push(...parsed.posts);

            console.error(`[get-thread] Fetched page ${pageNum}/${pagesToFetch}`);
          }
        }

        const result = {
          title: firstPage.title,
          tags: firstPage.tags,
          posts: allPosts,
          currentPage: fetch_all_pages ? Math.min(firstPage.totalPages, MAX_PAGES) : 1,
          totalPages: firstPage.totalPages,
          url,
          ...(fetch_all_pages && firstPage.totalPages > MAX_PAGES
            ? { note: `Capped at ${MAX_PAGES} pages (thread has ${firstPage.totalPages} total)` }
            : {}),
        };

        // Build content array
        const content: Array<
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        > = [{ type: "text", text: JSON.stringify(result) }];

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
            const img = await fetchImageAsBase64(imgUrl);
            if (img) {
              content.push({ type: "image", data: img.data, mimeType: img.mimeType });
              console.error(`[get-thread] Fetched image: ${imgUrl}`);
            }
          }
        }

        return { content };
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
