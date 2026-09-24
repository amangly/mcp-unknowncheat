# mcp-unknowncheat

A TypeScript MCP server for reading and searching the [UnknownCheats](https://www.unknowncheats.me) forum. It uses Bun, a local Chrome window, and Cheerio to parse forum pages.

## Demo

https://github.com/user-attachments/assets/9f00f783-0a03-4e8d-b5b6-abd308936f20

## Install

Install [Bun](https://bun.sh) and Google Chrome. The server uses `puppeteer-real-browser` and your installed browser; installation does not download a browser. Set `UC_CHROME_PATH` to an absolute Chrome or Chromium executable path if Chrome is not in its standard location. Run the npm package with:

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

The server uses MCP over standard input and output. Chrome opens when a tool first needs a page. It keeps a dedicated profile under the user's application data directory (`mcp-unknowncheat/chrome-profile`) so a manually completed browser challenge and login can survive restarts. Set `UC_PROFILE_DIR` to an absolute path to choose another profile; an existing `cookies.json` is imported only when the profile is first created. On Linux without a graphical display, Chrome runs headless; set `UC_HEADLESS=1` to request headless mode elsewhere. If a Cloudflare challenge appears, complete it in the visible Chrome window. The server waits up to 45 seconds by default (`UC_CF_WAIT_MS`), subject to each tool's time budget. Automated browsers are not guaranteed to pass production challenges. Clients may need a tool timeout over 60 seconds for first-time manual setup.

## Connect an MCP client

Install Bun and Chrome first. Your MCP client starts the server with `bunx mcp-unknowncheatz`; you do not need to leave a separate terminal running. The examples below use the published npm package. To use a source checkout, replace `bunx mcp-unknowncheatz` with `bun run /absolute/path/to/mcp-unknowncheat/src/index.ts`.

### Codex

Add the server from a terminal:

```sh
codex mcp add unknowncheat -- bunx mcp-unknowncheatz
codex mcp list
```

Or add this to `~/.codex/config.toml` (on Windows, `%USERPROFILE%\.codex\config.toml`):

```toml
[mcp_servers.unknowncheat]
command = "bunx"
args = ["mcp-unknowncheatz"]
tool_timeout_sec = 120
```

Restart Codex after editing the config file.

### Claude Code

```sh
claude mcp add --scope user unknowncheat -- bunx mcp-unknowncheatz
claude mcp list
```

Use `--scope project` if the server should be available only in one project.

### Claude Desktop and Cursor

Add the server entry under `mcpServers` in the client's JSON config. Claude Desktop uses `%APPDATA%\Claude\claude_desktop_config.json` on Windows or `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS. Cursor uses `~/.cursor/mcp.json` for all projects or `.cursor/mcp.json` in one project.

```json
{
  "mcpServers": {
    "unknowncheat": {
      "command": "bunx",
      "args": ["mcp-unknowncheatz"]
    }
  }
}
```

Merge this entry into an existing `mcpServers` object if you already have other servers. Quit and reopen the client after saving the file.

### VS Code

Add this to `.vscode/mcp.json` in your workspace, then run **MCP: List Servers** from the Command Palette to start or inspect it:

```json
{
  "servers": {
    "unknowncheat": {
      "type": "stdio",
      "command": "bunx",
      "args": ["mcp-unknowncheatz"]
    }
  }
}
```

For other clients, configure a local stdio MCP server with command `bunx` and argument `mcp-unknowncheatz`. If the client cannot find `bunx`, use its absolute executable path. On first use, allow time for the package to start and for any browser challenge; where supported, set a tool timeout of at least 120 seconds. Ask the client to list its MCP tools or call `check_login` to confirm the connection.

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
| `UC_CF_WAIT_MS` | `45000` | Time to wait for a Cloudflare challenge, in milliseconds |
| `UC_CACHE_TTL_MS` | `300000` | HTML cache lifetime, in milliseconds |
| `UC_MIN_REQUEST_INTERVAL_MS` | `900` | Minimum interval between crawl requests, in milliseconds |
| `UC_INDEX_PATH` | User application data directory | Path of the local SQLite search index |

The npm package is [mcp-unknowncheatz](https://www.npmjs.com/package/mcp-unknowncheatz). Report bugs in [GitHub Issues](https://github.com/amangly/mcp-unknowncheat/issues).
