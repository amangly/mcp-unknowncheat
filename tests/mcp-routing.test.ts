import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP advertises forum research routing and index tools", async () => {
  const client = new Client({ name: "metadata-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "src/index.ts"],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("game cheating scenes");
    expect(instructions).toContain("Start with search_index");
    expect(instructions).toContain("latest 3 pages of each plausible thread");
    const tools = (await client.listTools()).tools;
    for (const name of ["search_index", "search_forum", "get_thread", "find_latest_offsets", "index_subforum", "index_status"]) {
      expect(tools.some((tool) => tool.name === name)).toBe(true);
    }
    expect(tools.find((tool) => tool.name === "search_forum")?.description).toContain("anti-cheat");
    expect(tools.find((tool) => tool.name === "get_thread")?.description).toContain("latest 3 pages");
    expect(tools.find((tool) => tool.name === "bulk_get_threads")?.description).toContain("latest 3 pages");
    expect(tools.find((tool) => tool.name === "search_index")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "index_subforum")?.annotations?.openWorldHint).toBe(true);
  } finally {
    await client.close();
  }
}, 15_000);
