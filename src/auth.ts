import { load } from "cheerio";

export function isLoggedIn(html: string): boolean {
  const $ = load(html);
  return $('a[href*="login.php?do=logout"]').length > 0;
}
