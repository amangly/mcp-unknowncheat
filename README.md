# mcp-unknowncheat

A TypeScript MCP server for reading and searching the [UnknownCheats](https://www.unknowncheats.me) forum. It uses Bun, a local Chrome window, and Cheerio to parse forum pages.

## Demo

https://github.com/user-attachments/assets/9f00f783-0a03-4e8d-b5b6-abd308936f20

## Install

Install [Bun](https://bun.sh) and Chrome or Chromium. Run the npm package with:

```sh
bunx mcp-unknowncheatz
```

To run the source:

```sh
git clone https://github.com/amangly/mcp-unknowncheat.git
cd mcp-unknowncheat
bun install --frozen-lockfile
bun run start
```

The server uses MCP over standard input and output. Chrome opens when a tool first needs a page. You can log in with the `login` tool; session cookies are saved locally in `cookies.json`.

## Tools

| Tool | Purpose |
|---|---|
| `check_login` | Check session status |
| `login` | Log in with a username and password |
| `search_forum` | Search threads or browse a subforum |
| `get_thread` | Read posts and pages in a thread |
| `extract_code` | Extract code blocks from a thread |
| `download_file` | Download and inspect an attachment |
| `list_subforums` | List forum sections from a 24-hour local directory; use `refresh: true` to rebuild it |
| `crawl_subforum` | Collect threads from subforum pages |
| `bulk_get_threads` | Read several threads |
| `get_user_reputation` | Read reputation details |
| `find_latest_offsets` | Find a game's offsets thread in the forum and scan recent pages backward |
| `debug_page` | Inspect page structure |
| `crawl_cache` | Inspect or clear the HTML cache |
| `index_subforum` | Refresh a bounded local thread and post index for one subforum |
| `search_index` | Search indexed titles, snippets, and sampled posts without a network request |
| `index_status` | Show local index coverage, counts, and last update times; optionally filter by subforum |

The MCP tool schemas provide the available arguments. For example:

```text
search_forum({ query: "example" })
get_thread({ url: "https://www.unknowncheats.me/forum/showthread.php?t=123" })
find_latest_offsets({ game: "Apex Legends" })
index_subforum({ subforum: "apex-legends", max_listing_pages: 1, max_threads: 5 })
search_index({ query: "offsets", subforum: "apex-legends" })
```

The server advertises forum research tools for game cheating scenes, cheat techniques and tooling, anti-cheat, reversing, and offsets questions. The connected AI client decides whether to invoke them; tool descriptions and server instructions guide selection but do not force a call. For a specific claim, read its source thread and report the source URL and date.

The first directory lookup saves forum URLs in `forum-index.json`. Offsets lookups read the selected game's live thread listing, choose a linked candidate, and scan its recent pages from newest to oldest. Results include the listing URL, scanned pages, and source post. A matching post does not prove the offsets work with the current game build. If the game name is ambiguous, use a slug returned by `list_subforums` or pass an exact `thread_url`.

Browsing or crawling a subforum records its visible listing in the local index. Reading a thread records the pages visited. `index_subforum` additionally samples the first and recent post pages of changed threads, up to five by default, and rechecks unchanged threads after 24 hours. The index remains partial: `search_index` includes listing and post page counts, timestamps, and a partial coverage marker. Use live search when freshness or missing coverage matters. The SQLite database is stored under the user's application data directory (`mcp-unknowncheat/forum-index.sqlite`); set `UC_INDEX_PATH` to change it. Browser-backed tools share one page and run one at a time; a queued call returns a busy error after 10 seconds. `get_thread`, `bulk_get_threads`, `crawl_subforum`, `index_subforum`, and `find_latest_offsets` stop starting new page requests after a 45-second fetch budget. `crawl_cache` reports cache hits, queued requests, failures, and total fetch time.

## Development

```sh
bun run typecheck
bun run test
bun run build
bun run inspect:html -- path/to/saved-forum-page.html
```

The browser code and tools are in `src/`; HTML parsers are in `src/parsers/`. `downloads/`, `exports/`, `cookies.json`, and `forum-index.json` are local output ignored by Git.
The HTML inspector reads a saved page locally and reports selector counts, parser coverage, pagination, and challenge markers without fetching the site.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `UC_CF_WAIT_MS` | `15000` | Time to wait for a Cloudflare challenge, in milliseconds |
| `UC_CACHE_TTL_MS` | `300000` | HTML cache lifetime, in milliseconds |
| `UC_MIN_REQUEST_INTERVAL_MS` | `900` | Minimum interval between crawl requests, in milliseconds |
| `UC_INDEX_PATH` | User application data directory | Path of the local SQLite search index |

The npm package is [mcp-unknowncheatz](https://www.npmjs.com/package/mcp-unknowncheatz). Report bugs in [GitHub Issues](https://github.com/amangly/mcp-unknowncheat/issues).
