#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeBrowser } from "./browser.js";
import packageJson from "../package.json" with { type: "json" };
import { registerCheckLogin } from "./tools/check-login.js";
import { registerLogin } from "./tools/login.js";
import { registerSearchForum } from "./tools/search-forum.js";
import { registerGetThread } from "./tools/get-thread.js";
import { registerExtractCode } from "./tools/extract-code.js";
import { registerDebugPage } from "./tools/debug-page.js";
import { registerDownloadFile } from "./tools/download-file.js";
import { registerListSubforums } from "./tools/list-subforums.js";
import { registerCrawlSubforum } from "./tools/crawl-subforum.js";
import { registerBulkGetThreads } from "./tools/bulk-get-threads.js";
import { registerCacheControl } from "./tools/cache-control.js";
import { registerGetUserReputation } from "./tools/get-user-reputation.js";
import { registerFindLatestOffsets } from "./tools/find-latest-offsets.js";

const server = new McpServer(
  { name: "unknowncheats", version: packageJson.version },
  { instructions: "For the newest offsets for any game, call find_latest_offsets with the game name. It discovers the game forum and offset thread from live listings, then scans recent posts backward. Report the source post and scan coverage. Do not present a found post as a verified current game offset." }
);

// Register all tools
registerCheckLogin(server);
registerLogin(server);
registerSearchForum(server);
registerGetThread(server);
registerExtractCode(server);
registerDebugPage(server);
registerDownloadFile(server);
registerListSubforums(server);
registerCrawlSubforum(server);
registerBulkGetThreads(server);
registerCacheControl(server);
registerGetUserReputation(server);
registerFindLatestOffsets(server);

// Graceful shutdown
async function shutdown() {
  console.error("[server] Shutting down...");
  await closeBrowser();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Connect stdio transport (IMPORTANT: never write to stdout except via MCP)
const transport = new StdioServerTransport();
await server.connect(transport);

console.error("[server] MCP UnknownCheats server started (uc-mcp-server)");
