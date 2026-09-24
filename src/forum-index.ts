import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ThreadListEntry } from "./parsers/thread-list.js";
import type { ThreadPost } from "./types.js";
import type { ThreadData } from "./types.js";

const DATA_DIR = process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "mcp-unknowncheat")
  : path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "mcp-unknowncheat");
const DEFAULT_PATH = path.join(DATA_DIR, "forum-index.sqlite");

export interface IndexHit {
  kind: "thread" | "post";
  threadId: string;
  postId?: number;
  page?: number;
  title: string;
  url: string;
  subforum: string;
  excerpt: string;
  indexedAt: string;
}

function searchTerms(query: string): string {
  return (query.match(/[\p{L}\p{N}_]+/gu) ?? [])
    .slice(0, 12)
    .map((term) => `"${term}"*`)
    .join(" AND ");
}

export class ForumIndex {
  private readonly db: Database;

  constructor(filename = process.env.UC_INDEX_PATH ?? DEFAULT_PATH) {
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        subforum TEXT NOT NULL,
        author TEXT,
        last_post TEXT,
        replies INTEGER NOT NULL,
        views INTEGER NOT NULL,
        is_sticky INTEGER NOT NULL,
        prefix TEXT,
        snippet TEXT,
        seen_at TEXT NOT NULL,
        posts_indexed_at TEXT,
        indexed_replies INTEGER,
        indexed_last_post TEXT
      );
      CREATE TABLE IF NOT EXISTS posts (
        post_id INTEGER PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
        page INTEGER NOT NULL,
        author TEXT,
        posted_at TEXT,
        content TEXT NOT NULL,
        links_json TEXT NOT NULL,
        images_json TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS threads_subforum ON threads(subforum);
      CREATE INDEX IF NOT EXISTS posts_thread ON posts(thread_id, page);
      CREATE TABLE IF NOT EXISTS listing_pages (
        subforum TEXT NOT NULL,
        page INTEGER NOT NULL,
        thread_count INTEGER NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (subforum, page)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS threads_fts USING fts5(thread_id UNINDEXED, title, snippet);
      CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(post_id UNINDEXED, content);
    `);
  }

  close(): void {
    this.db.close();
  }

  upsertThreads(subforum: string, entries: ThreadListEntry[], seenAt = new Date().toISOString()): void {
    const existing = this.db.query("SELECT title, snippet FROM threads WHERE thread_id = ?");
    const upsert = this.db.query(`
      INSERT INTO threads (thread_id, url, title, subforum, author, last_post, replies, views,
                           is_sticky, prefix, snippet, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        url=excluded.url, title=excluded.title, subforum=excluded.subforum,
        author=excluded.author, last_post=excluded.last_post, replies=excluded.replies,
        views=excluded.views, is_sticky=excluded.is_sticky, prefix=excluded.prefix,
        snippet=excluded.snippet, seen_at=excluded.seen_at
    `);
    const deleteFts = this.db.query("DELETE FROM threads_fts WHERE thread_id = ?");
    const insertFts = this.db.query("INSERT INTO threads_fts (thread_id, title, snippet) VALUES (?, ?, ?)");
    this.db.transaction(() => {
      for (const entry of entries) {
        if (!/^\d+$/.test(entry.threadId)) continue;
        const old = existing.get(entry.threadId) as { title: string; snippet: string | null } | null;
        upsert.run(entry.threadId, entry.url, entry.title, subforum, entry.author ?? null,
          entry.date ?? null, entry.replies, entry.views, Number(entry.isSticky),
          entry.prefix ?? null, entry.snippet ?? null, seenAt);
        if (!old || old.title !== entry.title || old.snippet !== (entry.snippet ?? null)) {
          deleteFts.run(entry.threadId);
          insertFts.run(entry.threadId, entry.title, entry.snippet ?? "");
        }
      }
    })();
  }

  recordListing(subforum: string, page: number, entries: ThreadListEntry[], fetchedAt = new Date().toISOString()): void {
    this.upsertThreads(subforum, entries, fetchedAt);
    this.db.query(`INSERT INTO listing_pages (subforum, page, thread_count, fetched_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(subforum, page) DO UPDATE SET
      thread_count=excluded.thread_count, fetched_at=excluded.fetched_at`)
      .run(subforum, page, entries.length, fetchedAt);
  }

  recordSearchResults(entries: ThreadListEntry[]): void {
    const exists = this.db.query("SELECT 1 FROM threads WHERE thread_id = ?");
    this.upsertThreads("search-results", entries.filter((entry) => !exists.get(entry.threadId)));
  }

  recordThreadPage(thread: ThreadData, page: number, indexedAt = new Date().toISOString()): void {
    const url = new URL(thread.url);
    const threadId = url.searchParams.get("t") ?? url.pathname.match(/\/(\d+)(?:-[^/]*)?\.html$/)?.[1];
    if (!threadId || !/^\d+$/.test(threadId) || thread.posts.length === 0) return;
    const known = this.db.query("SELECT subforum FROM threads WHERE thread_id = ?")
      .get(threadId) as { subforum: string } | null;
    if (!known) {
      this.upsertThreads("unclassified", [{ threadId, url: thread.url, title: thread.title,
        author: thread.posts[0]?.author, replies: 0, views: 0, isSticky: false }], indexedAt);
    }
    this.upsertPosts(threadId, [{ page, posts: thread.posts }], indexedAt, false);
  }

  needsPosts(threadId: string, maxAgeMs = 24 * 60 * 60_000): boolean {
    const row = this.db.query(`
      SELECT replies, last_post, posts_indexed_at, indexed_replies, indexed_last_post
      FROM threads WHERE thread_id = ?
    `).get(threadId) as {
      replies: number; last_post: string | null; posts_indexed_at: string | null;
      indexed_replies: number | null; indexed_last_post: string | null;
    } | null;
    if (!row?.posts_indexed_at) return true;
    const age = Date.now() - Date.parse(row.posts_indexed_at);
    return !Number.isFinite(age) || age < 0 || age > maxAgeMs ||
      row.replies !== row.indexed_replies || row.last_post !== row.indexed_last_post;
  }

  upsertPosts(threadId: string, pages: Array<{ page: number; posts: ThreadPost[] }>, indexedAt = new Date().toISOString(), markCurrent = true): void {
    const existing = this.db.query("SELECT content FROM posts WHERE post_id = ?");
    const upsert = this.db.query(`
      INSERT INTO posts (post_id, thread_id, page, author, posted_at, content, links_json, images_json, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(post_id) DO UPDATE SET
        thread_id=excluded.thread_id, page=excluded.page, author=excluded.author,
        posted_at=excluded.posted_at, content=excluded.content, links_json=excluded.links_json,
        images_json=excluded.images_json, indexed_at=excluded.indexed_at
    `);
    const deleteFts = this.db.query("DELETE FROM posts_fts WHERE post_id = ?");
    const oldPagePosts = this.db.query("SELECT post_id FROM posts WHERE thread_id = ? AND page = ?");
    const deletePost = this.db.query("DELETE FROM posts WHERE post_id = ?");
    const insertFts = this.db.query("INSERT INTO posts_fts (post_id, content) VALUES (?, ?)");
    const markIndexed = this.db.query(`
      UPDATE threads SET posts_indexed_at = ?, indexed_replies = replies,
        indexed_last_post = last_post WHERE thread_id = ?
    `);
    this.db.transaction(() => {
      for (const { page, posts } of pages) {
        const currentIds = new Set(posts.map((post) => post.postNumber));
        for (const row of oldPagePosts.all(threadId, page) as Array<{ post_id: number }>) {
          if (!currentIds.has(row.post_id)) {
            deleteFts.run(row.post_id);
            deletePost.run(row.post_id);
          }
        }
        for (const post of posts) {
          const old = existing.get(post.postNumber) as { content: string } | null;
          upsert.run(post.postNumber, threadId, page, post.author, post.date, post.content,
            JSON.stringify(post.links), JSON.stringify(post.images), indexedAt);
          if (!old || old.content !== post.content) {
            deleteFts.run(post.postNumber);
            insertFts.run(post.postNumber, post.content);
          }
        }
      }
      if (markCurrent) markIndexed.run(indexedAt, threadId);
    })();
  }

  search(query: string, subforum?: string, limit = 20): IndexHit[] {
    const terms = searchTerms(query);
    if (!terms) return [];
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const threads = this.db.query(`
      SELECT t.thread_id AS threadId, t.title, t.url, t.subforum,
        COALESCE(t.snippet, '') AS excerpt, t.seen_at AS indexedAt
      FROM threads_fts JOIN threads t ON t.thread_id = threads_fts.thread_id
      WHERE threads_fts MATCH ? AND (? IS NULL OR t.subforum = ?)
      ORDER BY bm25(threads_fts) LIMIT ?
    `).all(terms, subforum ?? null, subforum ?? null, safeLimit) as Omit<IndexHit, "kind">[];
    const posts = this.db.query(`
      SELECT t.thread_id AS threadId, p.post_id AS postId, p.page, t.title, t.url, t.subforum,
        substr(p.content, 1, 300) AS excerpt, p.indexed_at AS indexedAt
      FROM posts_fts JOIN posts p ON p.post_id = posts_fts.post_id
        JOIN threads t ON t.thread_id = p.thread_id
      WHERE posts_fts MATCH ? AND (? IS NULL OR t.subforum = ?)
      ORDER BY bm25(posts_fts) LIMIT ?
    `).all(terms, subforum ?? null, subforum ?? null, safeLimit) as Omit<IndexHit, "kind">[];
    const hits: IndexHit[] = [];
    for (let i = 0; hits.length < safeLimit && (i < threads.length || i < posts.length); i++) {
      const thread = threads[i];
      const post = posts[i];
      if (thread) hits.push({ ...thread, kind: "thread" });
      if (post && hits.length < safeLimit) {
        const url = new URL(post.url);
        if (post.page && post.page > 1) url.searchParams.set("page", String(post.page));
        url.hash = `post${post.postId}`;
        hits.push({ ...post, kind: "post", url: url.toString() });
      }
    }
    return hits;
  }

  status(subforum?: string): { subforum: string | null; threads: number; posts: number; listingPages: number; listedPages: number[] | null; postPages: number; sampledThreads: number; lastSeenAt: string | null; lastPostsIndexedAt: string | null; coverage: "partial" } {
    const scope = [subforum ?? null, subforum ?? null];
    const row = this.db.query(`
      SELECT (SELECT count(*) FROM threads WHERE (? IS NULL OR subforum = ?)) AS threads,
        (SELECT count(*) FROM posts p JOIN threads t ON t.thread_id = p.thread_id
          WHERE (? IS NULL OR t.subforum = ?)) AS posts,
        (SELECT count(*) FROM listing_pages WHERE (? IS NULL OR subforum = ?)) AS listingPages,
        (SELECT count(*) FROM (SELECT DISTINCT p.thread_id, p.page FROM posts p
          JOIN threads t ON t.thread_id = p.thread_id WHERE (? IS NULL OR t.subforum = ?))) AS postPages,
        (SELECT count(*) FROM threads WHERE posts_indexed_at IS NOT NULL
          AND (? IS NULL OR subforum = ?)) AS sampledThreads,
        (SELECT max(seen_at) FROM threads WHERE (? IS NULL OR subforum = ?)) AS lastSeenAt,
        (SELECT max(posts_indexed_at) FROM threads WHERE (? IS NULL OR subforum = ?)) AS lastPostsIndexedAt
    `).get(...scope, ...scope, ...scope, ...scope, ...scope, ...scope, ...scope) as {
      threads: number; posts: number; listingPages: number; postPages: number;
      sampledThreads: number; lastSeenAt: string | null; lastPostsIndexedAt: string | null;
    };
    const listedPages = subforum
      ? (this.db.query("SELECT page FROM listing_pages WHERE subforum = ? ORDER BY page")
          .all(subforum) as Array<{ page: number }>).map((entry) => entry.page)
      : null;
    return { subforum: subforum ?? null, ...row, listedPages, coverage: "partial" };
  }
}

let shared: ForumIndex | null = null;
export function getForumIndex(): ForumIndex {
  shared ??= new ForumIndex();
  return shared;
}
