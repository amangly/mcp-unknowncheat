import { describe, expect, test } from "bun:test";
import { parseThread } from "../src/parsers/thread.ts";
import { parseThreadList } from "../src/parsers/thread-list.ts";
import { parseCodeBlocks } from "../src/parsers/code-blocks.ts";
import { searchViaSubforums } from "../src/search-fallback.ts";

describe("forum HTML parsers", () => {
  test("removes both page and site suffixes from thread titles", () => {
    const thread = parseThread("<title>Example - Page 2 - unknowncheats.me</title>", "https://www.unknowncheats.me/forum/showthread.php?t=1", 2);
    expect(thread.title).toBe("Example");
    expect(thread.currentPage).toBe(2);
  });

  test("keeps thousands separators in search statistics", () => {
    const html = `<table><tr><td><a id="thread_title_1" href="/forum/showthread.php?t=1">Example</a></td><td>1,234 Replies</td><td>56,789 Views</td></tr></table>`;
    expect(parseThreadList(html)).toMatchObject([{ replies: 1234, views: 56789 }]);
  });

  test("extracts a code block once when selectors overlap", () => {
    const html = `<table id="post123"><tr><td><div class="highlight"><code>std::cout << "hello";</code></div></td></tr></table>`;
    expect(parseCodeBlocks(html)).toMatchObject([{ language: "cpp", postId: "post123" }]);
  });

  test("fallback search uses the shared thread-list parser", async () => {
    const index = `<a href="/forum/apex-legends/">Apex Legends</a>`;
    const listing = `<table><tr><td><a id="thread_title_42" href="/forum/showthread.php?t=42">Apex example</a></td><td>1,234 Replies</td><td>56,789 Views</td></tr></table>`;
    const { results, scannedSubforums } = await searchViaSubforums("apex", async (url) =>
      url.endsWith("index.php") ? index : listing
    );
    expect(scannedSubforums).toEqual(["apex-legends"]);
    expect(results).toMatchObject([{ threadId: "42", replies: 1234, views: 56789 }]);
  });

  test("fallback search reuses the catalog and routes PUBG to the main forum", async () => {
    const requested: string[] = [];
    const listing = `<a id="thread_title_42" href="/forum/showthread.php?t=42">PUBG offsets</a>`;
    const { scannedSubforums } = await searchViaSubforums("PUBG offsets", async (url) => {
      requested.push(url);
      return listing;
    }, [
      { slug: "pubg-mobile", label: "PUBG Mobile" },
      { slug: "pubg-releases", label: "PUBG Releases" },
      { slug: "playerunknown-s-battlegrounds", label: "Playerunknown's Battlegrounds" },
    ]);
    expect(scannedSubforums[0]).toBe("playerunknown-s-battlegrounds");
    expect(requested.some((url) => url.endsWith("index.php"))).toBe(false);
  });
});
