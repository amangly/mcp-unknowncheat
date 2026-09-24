import { describe, expect, test } from "bun:test";
import { ForumIndex } from "../src/forum-index.ts";
import { syncSubforumIndex } from "../src/sync-index.ts";
import { inspectForumHtml } from "../src/inspect-html.ts";
import { parseThread } from "../src/parsers/thread.ts";
import { parseThreadList } from "../src/parsers/thread-list.ts";
import { existsSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const listing = `<div class="pagenav">Page 1 of 1</div><table>
  <tr><td><a id="thread_title_42" href="/forum/showthread.php?t=42">Apex offsets</a></td>
  <td>2 Replies</td><td>20 Views</td></tr></table>`;
const firstPage = `<title>Apex offsets - unknowncheats.me</title><div class="pagenav">Page 1 of 2</div>
  <table id="post100"><tr><td class="thead">Today</td><td><a class="bigusername">author</a>
  <div id="post_message_100">Initial offset list</div></td></tr></table>`;
const lastPage = `<title>Apex offsets - Page 2 - unknowncheats.me</title><div class="pagenav">Page 2 of 2</div>
  <table id="post101"><tr><td class="thead">Today</td><td><a class="bigusername">author</a>
  <div id="post_message_101">Updated offset value</div></td></tr></table>`;

describe("local forum index", () => {
  test("reports parser coverage for saved HTML", () => {
    expect(inspectForumHtml(listing)).toMatchObject({
      likelyPage: "listing", selectors: { threadTitleLinks: 1 }, parsed: { threads: 1, listingPages: 1 },
    });
    expect(inspectForumHtml(firstPage)).toMatchObject({
      likelyPage: "thread", selectors: { postTables: 1, postMessages: 1 }, parsed: { posts: 1, threadPages: 2 },
    });
  });
  test("indexes first and recent pages, then skips unchanged threads", async () => {
    const index = new ForumIndex(":memory:");
    const requested: string[] = [];
    const fetcher = async (url: string): Promise<string> => {
      requested.push(url);
      if (url.includes("page=2")) return lastPage;
      if (url.includes("showthread.php")) return firstPage;
      return listing;
    };
    try {
      const options = { maxListingPages: 1, maxThreads: 5, recentPages: 1 };
      const first = await syncSubforumIndex(index, "apex-legends", options, fetcher);
      expect(first).toMatchObject({ threadsSeen: 1, threadsUpdated: 1, postPagesFetched: 2, errors: [] });
      expect(index.status()).toMatchObject({ threads: 1, posts: 2 });
      expect(index.search("offset", "apex-legends").map((hit) => hit.kind)).toEqual(["thread", "post", "post"]);
      expect(index.search("updated")[0]).toMatchObject({ kind: "post", postId: 101, page: 2,
        url: "https://www.unknowncheats.me/forum/showthread.php?t=42&page=2#post101" });
      const second = await syncSubforumIndex(index, "apex-legends", options, fetcher);
      expect(second).toMatchObject({ threadsSkipped: 1, threadsUpdated: 0 });
      expect(requested).toHaveLength(4);
      expect(index.search("offset' OR *")).toEqual([]);
      index.upsertPosts("42", [{ page: 2, posts: [{
        postNumber: 102, author: "author", date: "Today", content: "New value",
        links: [], images: [],
      }] }]);
      expect(index.search("updated")).toEqual([]);
      expect(index.status().posts).toBe(2);
    } finally {
      index.close();
    }
  });

  test("does not mark a thread current after a failed page fetch", async () => {
    const index = new ForumIndex(":memory:");
    try {
      const result = await syncSubforumIndex(index, "apex-legends",
        { maxListingPages: 1, maxThreads: 1, recentPages: 1 }, async (url) => {
          if (url.includes("page=2")) throw new Error("page unavailable");
          return url.includes("showthread.php") ? firstPage : listing;
        });
      expect(result.errors[0]?.message).toBe("page unavailable");
      expect(index.status()).toMatchObject({ threads: 1, posts: 0 });
      expect(index.needsPosts("42")).toBe(true);
    } finally {
      index.close();
    }
  });

  test("ordinary listing and thread reads populate partial coverage without clobbering forum identity", () => {
    const index = new ForumIndex(":memory:");
    try {
      index.recordListing("apex-legends", 1, parseThreadList(listing));
      index.recordSearchResults(parseThreadList(listing));
      index.recordThreadPage(parseThread(firstPage,
        "https://www.unknowncheats.me/forum/showthread.php?t=42", 1), 1);
      expect(index.status("apex-legends")).toMatchObject({
        threads: 1, posts: 1, listingPages: 1, listedPages: [1], postPages: 1,
        sampledThreads: 0, coverage: "partial",
      });
      expect(index.search("initial", "apex-legends")[0]).toMatchObject({ kind: "post", postId: 100 });
      expect(index.status("search-results").threads).toBe(0);
      expect(index.needsPosts("42")).toBe(true);
    } finally {
      index.close();
    }
  });

  test("expired sync budget does not start a network fetch", async () => {
    const index = new ForumIndex(":memory:");
    try {
      let fetched = false;
      const result = await syncSubforumIndex(index, "apex-legends", {
        maxListingPages: 1, maxThreads: 1, recentPages: 1, deadlineAt: Date.now() - 1,
      }, async () => { fetched = true; return listing; });
      expect(fetched).toBe(false);
      expect(result).toMatchObject({ timeBudgetReached: true, listingPages: [], threadsUpdated: 0 });
    } finally {
      index.close();
    }
  });

  test("unchanged sampled posts wait a day before refresh", () => {
    const index = new ForumIndex(":memory:");
    try {
      index.recordListing("apex-legends", 1, parseThreadList(listing));
      const sampledPost = parseThread(firstPage,
        "https://www.unknowncheats.me/forum/showthread.php?t=42", 1).posts;
      index.upsertPosts("42", [{ page: 1, posts: sampledPost }],
        new Date(Date.now() - 2 * 60 * 60_000).toISOString());
      expect(index.needsPosts("42")).toBe(false);
      index.upsertPosts("42", [{ page: 1, posts: sampledPost }],
        new Date(Date.now() - 25 * 60 * 60_000).toISOString());
      expect(index.needsPosts("42")).toBe(true);
    } finally {
      index.close();
    }
  });

  test("retains searchable records across index reopen", async () => {
    const filename = path.join(os.tmpdir(), `uc-index-${randomUUID()}.sqlite`);
    try {
      const first = new ForumIndex(filename);
      await syncSubforumIndex(first, "apex-legends",
        { maxListingPages: 1, maxThreads: 1, recentPages: 1 }, async (url) =>
          url.includes("page=2") ? lastPage : url.includes("showthread.php") ? firstPage : listing);
      first.close();
      const reopened = new ForumIndex(filename);
      try {
        expect(reopened.search("updated")[0]).toMatchObject({ postId: 101 });
        expect(reopened.needsPosts("42")).toBe(false);
      } finally {
        reopened.close();
      }
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        const file = `${filename}${suffix}`;
        if (existsSync(file)) unlinkSync(file);
      }
    }
  });
});
