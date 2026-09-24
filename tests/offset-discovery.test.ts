import { describe, expect, test } from "bun:test";
import { parseSubforums } from "../src/parsers/subforums.ts";
import { parseThreadList } from "../src/parsers/thread-list.ts";
import { containsOffsetUpdate, rankGameForums, rankOffsetThreads, rankSharedForumOffsetThreads } from "../src/offset-discovery.ts";
import type { ThreadPost } from "../src/types.ts";

describe("offset discovery", () => {
  test("chooses an exact game forum ahead of similarly named games", () => {
    const html = `<a href="/forum/apex-legends-mobile/">Apex Legends Mobile</a><a href="/forum/apex-legends/">Apex Legends</a><a href="/forum/playerunknown-s-battlegrounds/">Playerunknown's Battlegrounds</a>`;
    expect(rankGameForums("Apex Legends", parseSubforums(html)).map((forum) => forum.slug))
      .toEqual(["apex-legends", "apex-legends-mobile"]);
    expect(rankGameForums("Playerunknowns Battlegrounds", parseSubforums(html)).map((forum) => forum.slug))
      .toEqual(["playerunknown-s-battlegrounds"]);
    expect(rankGameForums("Unknown Game", parseSubforums(html))).toEqual([]);
  });

  test("routes common game names to their main forums", () => {
    const html = `<a href="/forum/pubg-mobile/">PUBG Mobile</a>
      <a href="/forum/pubg-releases/">PUBG Releases</a>
      <a href="/forum/playerunknown-s-battlegrounds/">Playerunknown's Battlegrounds</a>
      <a href="/forum/counter-strike-2-a/">Counter-Strike 2</a>`;
    const forums = parseSubforums(html);
    expect(rankGameForums("PUBG", forums)[0]?.slug).toBe("playerunknown-s-battlegrounds");
    expect(rankGameForums("CS2", forums)[0]?.slug).toBe("counter-strike-2-a");
  });

  test("discovers an offset thread only from parsed listing links", () => {
    const html = `<table>
      <tr><td><a id="thread_title_1" href="/forum/apex-legends/1-chat.html">General chat</a></td></tr>
      <tr><td><a id="thread_title_716406" href="/forum/apex-legends/716406-apex-reversal-structs-offsets.html">Apex Reversal, Structs and Offsets</a></td></tr>
    </table>`;
    const listing = "https://www.unknowncheats.me/forum/apex-legends/";
    expect(rankOffsetThreads(parseThreadList(html), listing)).toMatchObject([{
      title: "Apex Reversal, Structs and Offsets",
      url: "https://www.unknowncheats.me/forum/apex-legends/716406-apex-reversal-structs-offsets.html",
      listingPage: listing,
    }]);
  });

  test("finds CN offset threads inside a shared game forum", () => {
    const html = `<a id="thread_title_1" href="/other-fps-games/653290-delta-force-hawk-ops-reversal-structs-offsets.html">Delta Force:Hawk Ops Reversal, Structs and Offsets</a>
      <a id="thread_title_2" href="/other-fps-games/741559-delta-force-wegame-structs-offsets.html">Delta Force WeGame， Structs and Offsets</a>`;
    const threads = parseThreadList(html);
    expect(rankSharedForumOffsetThreads("Delta Force CN", threads, "search").map((thread) => thread.threadId)).toEqual(["2"]);
    expect(rankSharedForumOffsetThreads("Delta Force", threads, "search").map((thread) => thread.threadId)).toEqual(["1", "2"]);
  });

  test("distinguishes an update from a request for offsets", () => {
    const post = (content: string, links: ThreadPost["links"] = []): ThreadPost => ({
      author: "tester", date: "today", postNumber: 1, content, links, images: [],
    });
    expect(containsOffsetUpdate(post("Newest offsets https://pastebin.com/example", [
      { text: "paste", url: "https://pastebin.com/example" },
    ]))).toBe(true);
    expect(containsOffsetUpdate(post("Does anyone have the newest offsets?"))).toBe(false);
    expect(containsOffsetUpdate(post("OFF_ENTITY = 0x12345; OFF_HEALTH = 0x23456; OFF_NAME = 0x34567;"))).toBe(true);
    expect(containsOffsetUpdate(post("anyone has updated namespace Offset { dwPawn = 0x12345; dwHealth = 0x23456; dwName = 0x34567; }"))).toBe(false);
    expect(containsOffsetUpdate(post("Hey, I'm having trouble. Does anyone know the current bit layout? namespace Offset { dwPawn = 0x12345; dwHealth = 0x23456; dwName = 0x34567; }"))).toBe(false);
    expect(containsOffsetUpdate(post("C_CSPlayerPawn primary vtable = 0x181B25738 slot index = 177 slot byte offset = 177 * 8 = 0x588 vtable entry = 0x181B25CC0 function = client.dll+0x165B30"))).toBe(false);
  });
});
