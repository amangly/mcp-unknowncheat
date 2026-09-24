import { load } from "cheerio";
import { navigateWithRetry } from "./browser.js";
import { getForumIndex } from "./forum-index.js";
import { parseThreadList } from "./parsers/thread-list.js";
import { normalizeName } from "./offset-discovery.js";

const SEARCH_URL = "https://www.unknowncheats.me/forum/search.php";

export async function searchNativeThreads(query: string, titleOnly = true, sortBy = "relevancy", searchUser = "", deadlineAt?: number) {
  const { page } = await navigateWithRetry(SEARCH_URL, deadlineAt);
  const submitted = await page.evaluate((opts) => {
    const form = [...document.forms].find((candidate) =>
      candidate.querySelector('input[name="query"]') &&
      (candidate.id === "searchform" || candidate.name === "searchform" || candidate.action.includes("search.php")));
    if (!form) return { ok: false, loginRequired: !!document.querySelector('input[name="securitytoken"][value="guest"]') };
    const input = form.querySelector('input[name="query"][size="35"]') as HTMLInputElement | null
      ?? form.querySelector('input[name="query"]') as HTMLInputElement | null;
    if (!input) return { ok: false, loginRequired: false };
    input.value = opts.query;
    const titleSelect = form.querySelector('select[name="titleonly"]') as HTMLSelectElement | null;
    if (titleSelect?.querySelector(`option[value="${opts.titleOnly ? "1" : "0"}"]`)) titleSelect.value = opts.titleOnly ? "1" : "0";
    const showThreads = form.querySelector('input[name="showposts"][value="0"]') as HTMLInputElement | null;
    if (showThreads) showThreads.checked = true;
    const sortSelect = form.querySelector('select[name="sortby"]') as HTMLSelectElement | null;
    if (sortSelect?.querySelector(`option[value="${opts.sortBy}"]`)) sortSelect.value = opts.sortBy;
    if (opts.searchUser) {
      const userInput = form.querySelector('input[name="searchuser"]') as HTMLInputElement | null;
      if (userInput) userInput.value = opts.searchUser;
    }
    return { ok: true, loginRequired: false };
  }, { query, titleOnly, sortBy, searchUser });
  if (!submitted.ok) throw new Error(submitted.loginRequired
    ? "Forum advanced search requires a logged-in session"
    : `Forum search form is unavailable (page: ${await page.title()})`);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: Math.max(1, Math.min(30_000, (deadlineAt ?? Infinity) - Date.now())) }),
    page.evaluate(() => {
      const form = [...document.forms].find((candidate) =>
        candidate.querySelector('input[name="query"]') &&
        (candidate.id === "searchform" || candidate.name === "searchform" || candidate.action.includes("search.php")));
      if (!form) throw new Error("Forum search form disappeared before submission");
      const button = form.querySelector('input[type="submit"], button[type="submit"]') as HTMLElement | null;
      if (button) button.click();
      else form.requestSubmit();
    }),
  ]);

  const html = await page.content();
  const parsed = parseThreadList(html);
  const $ = load(html);
  const pageTitle = $("title").text().trim();
  const errorText = $(".standard_error, .errorwrap, .blockbody .error").first().text().trim();
  if (errorText) throw new Error(`Forum search failed: ${errorText}`);
  if (!/Search Results/i.test(pageTitle)) {
    throw new Error(`Forum did not return search results (page: ${pageTitle || "untitled"})`);
  }
  const terms = normalizeName(query).split(" ").filter(Boolean);
  const results = titleOnly
    ? parsed.filter((thread) => terms.every((term) => normalizeName(thread.title).split(" ").includes(term)))
    : parsed;
  if (results.length > 0) getForumIndex().recordSearchResults(results);
  const pageNav = $(".pagenav td.vbmenu_control").first().text().trim();
  const pageMatch = pageNav.match(/Page (\d+) of (\d+)/);
  const pagination = pageMatch ? { currentPage: Number(pageMatch[1]), totalPages: Number(pageMatch[2]) } : undefined;
  return { results, pageTitle, pagination, resultsUrl: page.url() };
}
