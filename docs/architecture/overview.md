# How the server works

`src/index.ts` starts an MCP server over standard input and output and registers the tools in `src/tools/`. Most tools return structured results as JSON text. Diagnostics go to standard error so they do not corrupt the MCP stream.

```text
MCP client
    |
    v
src/index.ts -> src/tools/*
                    |                 +-> src/forum-index.ts (local SQLite FTS5)
                    +-> src/crawl.ts --+
                            |          +-> src/parsers/* -> tool result
                            v
                     src/browser.ts -> Chrome -> UnknownCheats
```

## Browser and fetching

`src/browser.ts` owns one Chrome session and shared page. `withBrowserSession` holds that page for an entire tool operation so another tool cannot navigate it mid-read. URL validation permits HTTP(S) requests only to `unknowncheats.me` hosts. Navigation retries a small set of browser failures and waits for a visible challenge when necessary.

`src/crawl.ts` normalizes thread URLs, validates the destination, caches HTML for five minutes by default, joins matching in-flight requests, and serializes requests behind a minimum interval. Callers can bypass the cache or pass a deadline. Multi-page tools cap the pages or threads they fetch and stop starting requests when their time budget expires. Keep incomplete coverage visible in tool output.

The Chrome profile and SQLite database are stored under the user's application data directory by default. `UC_PROFILE_DIR` and `UC_INDEX_PATH` override their locations. See the [README configuration table](../../README.md#configuration) for the other runtime settings.

## Parsing and search

`src/parsers/` extracts forum sections, thread listings, posts, code blocks, and reputation from HTML. `src/forum-url.ts` repairs known legacy thread paths and detects Apache not-found pages. Keep page-shape handling in these modules so live tools and offline tests use the same rules.

`search_index` queries the local SQLite FTS5 index without opening Chrome. `index_status` reports its coverage. `src/sync-index.ts` refreshes bounded subforum listings and samples the first and recent pages of selected threads; other browse and read tools also record pages they visit. The index is intentionally partial. A hit is a lead, and an absent hit is not proof that the forum has no match.

`search_forum` uses the forum's native search when signed in. If that search is unavailable, it tries indexed titles and then relevant subforum listings. `find_latest_offsets` discovers candidate threads and compares recent pages. `src/thread-pages.ts` tracks page coverage for thread reads. A claim about the latest post needs the returned fetched page numbers and completion flag, not just a search result or first page.

## Adding or changing a tool

Register the tool from `src/index.ts` and implement its schema and response in `src/tools/`. Use the shared fetch and parser paths. Treat forum HTML and post text as untrusted data. Include source URLs, dates, and coverage limits when the output supports a research claim. Add a focused test for changed parsing, URL handling, indexing, or result semantics; see [testing](../contributing/testing.md).
