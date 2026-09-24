import { describe, expect, test } from "bun:test";
import { parseThread } from "../src/parsers/thread.ts";
import { parseThreadList } from "../src/parsers/thread-list.ts";
import { parseCodeBlocks } from "../src/parsers/code-blocks.ts";
import { searchViaSubforums } from "../src/search-fallback.ts";
import { isApacheNotFoundPage, normalizeThreadUrl } from "../src/forum-url.ts";

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

  test("repairs root-relative forum search links and legacy thread URLs", () => {
    const html = `<a id="thread_title_741559" href="/other-fps-games/741559-delta-force-wegame-structs-offsets.html">Delta Force WeGame offsets</a>`;
    const url = "https://www.unknowncheats.me/forum/other-fps-games/741559-delta-force-wegame-structs-offsets.html";
    expect(parseThreadList(html)[0].url).toBe(url);
    expect(normalizeThreadUrl("https://www.unknowncheats.me/other-fps-games/741559-delta-force-wegame-structs-offsets.html")).toBe(url);
    expect(normalizeThreadUrl("https://www.unknowncheats.me/showthread.php?t=741559")).toBe("https://www.unknowncheats.me/forum/showthread.php?t=741559");
  });

  test("recognizes the Apache 404 page instead of parsing it as a thread", () => {
    expect(isApacheNotFoundPage("<title>404 Not Found</title><p>Apache Server at www.unknowncheats.me Port 443</p>")).toBe(true);
    expect(isApacheNotFoundPage("<title>Example</title><p>404 Not Found mentioned in a post</p>")).toBe(false);
  });

  test("resolves relative post links inside the forum", () => {
    const html = `<title>Example</title><table id="post123"><tr><td><a class="bigusername">tester</a><div id="post_message_123"><a href="other-fps-games/741559-example.html">thread</a><img src="images/example.png"></div></td></tr></table>`;
    const parsed = parseThread(html, "https://www.unknowncheats.me/forum/showthread.php?t=123");
    expect(parsed.posts[0].links[0].url).toBe("https://www.unknowncheats.me/forum/other-fps-games/741559-example.html");
    expect(parsed.posts[0].images[0]).toBe("https://www.unknowncheats.me/forum/images/example.png");
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
