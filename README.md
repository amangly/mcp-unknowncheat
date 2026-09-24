# mcp-unknowncheat

A TypeScript MCP server for reading and searching the [UnknownCheats](https://www.unknowncheats.me) forum. It uses Bun, a local Chrome window, and Cheerio to parse forum pages.

## Demo

https://github.com/user-attachments/assets/bcb9e608-d7f1-4bf4-8fe6-5d46ef6fcc3f

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

The MCP tool schemas provide the available arguments. For example:

```text
search_forum({ query: "example" })
get_thread({ url: "https://www.unknowncheats.me/forum/showthread.php?t=123" })
find_latest_offsets({ game: "Apex Legends" })
```

The first directory lookup saves forum URLs in `forum-index.json`. Offsets lookups read the selected game's live thread listing, choose a linked candidate, and scan its recent pages from newest to oldest. Results include the listing URL, scanned pages, and source post. A matching post does not prove the offsets work with the current game build. If the game name is ambiguous, use a slug returned by `list_subforums` or pass an exact `thread_url`.

## Development

```sh
bun run typecheck
bun run test
bun run build
```

The browser code and tools are in `src/`; HTML parsers are in `src/parsers/`. `downloads/`, `exports/`, `cookies.json`, and `forum-index.json` are local output ignored by Git.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `UC_CF_WAIT_MS` | `15000` | Time to wait for a Cloudflare challenge, in milliseconds |
| `UC_CACHE_TTL_MS` | `300000` | HTML cache lifetime, in milliseconds |
| `UC_MIN_REQUEST_INTERVAL_MS` | `900` | Minimum interval between crawl requests, in milliseconds |

The npm package is [mcp-unknowncheatz](https://www.npmjs.com/package/mcp-unknowncheatz). Report bugs in [GitHub Issues](https://github.com/amangly/mcp-unknowncheat/issues).
