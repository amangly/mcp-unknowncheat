import { load } from "cheerio";
import { parsePaginationInfo, parseThreadList } from "./parsers/thread-list.js";
import { parseSubforums } from "./parsers/subforums.js";
import { parseThread } from "./parsers/thread.js";

export function inspectForumHtml(html: string) {
  const $ = load(html);
  const listing = parseThreadList(html);
  const thread = parseThread(html, "https://www.unknowncheats.me/forum/showthread.php?t=0");
  const subforums = parseSubforums(html);
  const title = $("title").first().text().trim();
  return {
    title,
    challengeDetected: /Just a moment|cf-browser-verification|Checking your browser/i.test(html),
    likelyPage: thread.posts.length > 0 ? "thread" : listing.length > 0 ? "listing" : subforums.length > 0 ? "forum_index" : "unrecognized",
    selectors: {
      subforumLinks: $("a[href*='/forum/']").length,
      threadTitleLinks: $("a[id^='thread_title_']").length,
      postTables: $("table[id^='post']").length,
      postMessages: $("div[id^='post_message_']").length,
      pagination: $(".pagenav").length,
    },
    parsed: {
      subforums: subforums.length,
      threads: listing.length,
      posts: thread.posts.length,
      listingPages: parsePaginationInfo(html).totalPages,
      threadPages: thread.totalPages,
    },
  };
}
