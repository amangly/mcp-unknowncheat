import { describe, expect, test } from "bun:test";
import { parseThread } from "../src/parsers/thread.ts";
import { parseSearchResults } from "../src/parsers/search-results.ts";
import { parseCodeBlocks } from "../src/parsers/code-blocks.ts";

describe("forum HTML parsers", () => {
  test("removes both page and site suffixes from thread titles", () => {
    const thread = parseThread("<title>Example - Page 2 - unknowncheats.me</title>", "https://www.unknowncheats.me/forum/showthread.php?t=1", 2);
    expect(thread.title).toBe("Example");
    expect(thread.currentPage).toBe(2);
  });

  test("keeps thousands separators in search statistics", () => {
    const html = `<div class="searchresult"><div class="threadtitle"><a href="/forum/showthread.php?t=1">Example</a></div><div class="threadstats">1,234 replies 56,789 views</div></div>`;
    expect(parseSearchResults(html)).toMatchObject([{ replies: 1234, views: 56789 }]);
  });

  test("extracts a code block once when selectors overlap", () => {
    const html = `<table id="post123"><tr><td><div class="highlight"><code>std::cout << "hello";</code></div></td></tr></table>`;
    expect(parseCodeBlocks(html)).toMatchObject([{ language: "cpp", postId: "post123" }]);
  });
});
