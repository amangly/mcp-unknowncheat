const FORUM_BASE = "https://www.unknowncheats.me/forum/";

export function normalizeThreadUrl(input: string): string {
  const url = new URL(input, FORUM_BASE);
  if ((url.hostname === "www.unknowncheats.me" || url.hostname === "unknowncheats.me") &&
      (/^\/[a-z0-9-]+\/\d+-[^/]+\.html$/i.test(url.pathname) || url.pathname === "/showthread.php")) {
    url.pathname = `/forum${url.pathname}`;
  }
  return url.toString();
}

export function isApacheNotFoundPage(html: string): boolean {
  return /<title>\s*404 Not Found\s*<\/title>/i.test(html) &&
    /Apache Server at (?:www\.)?unknowncheats\.me/i.test(html);
}
