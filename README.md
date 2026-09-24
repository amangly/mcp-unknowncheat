# uc-mcp-server

A TypeScript MCP server for reading and searching the [UnknownCheats](https://www.unknowncheats.me) forum. It uses Bun, a local Chrome window, and Cheerio to parse forum pages.

## Install

Install [Bun](https://bun.sh) and Chrome or Chromium. Then run:

```sh
bunx uc-mcp-server
```

To run from source:

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
| `list_subforums` | List forum sections |
| `crawl_subforum` | Collect threads from subforum pages |
| `bulk_get_threads` | Read several threads |
| `get_user_reputation` | Read reputation details |
| `debug_page` | Inspect page structure |
| `crawl_cache` | Inspect or clear the HTML cache |

The MCP tool schemas provide the available arguments. For example:

```text
search_forum({ query: "example" })
get_thread({ url: "https://www.unknowncheats.me/forum/showthread.php?t=123" })
```

## Development

```sh
bun run typecheck
bun run test
bun run build
```

The browser code and tools are in `src/`; HTML parsers are in `src/parsers/`. `downloads/`, `exports/`, and `cookies.json` hold local output and are ignored by Git.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `UC_CF_WAIT_MS` | `15000` | Time to wait for a Cloudflare challenge, in milliseconds |
| `UC_CACHE_TTL_MS` | `300000` | HTML cache lifetime, in milliseconds |
| `UC_MIN_REQUEST_INTERVAL_MS` | `900` | Minimum interval between crawl requests, in milliseconds |

The npm package is [uc-mcp-server](https://www.npmjs.com/package/uc-mcp-server). Report bugs in [GitHub Issues](https://github.com/amangly/mcp-unknowncheat/issues).
