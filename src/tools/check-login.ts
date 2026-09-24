import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { load } from "cheerio";
import { navigateWithRetry } from "../browser.js";

const UC_HOME = "https://www.unknowncheats.me/forum/";

export function registerCheckLogin(server: McpServer): void {
  server.tool("check_login", "Check if the browser session is logged into UnknownCheats", {}, async () => {
    try {
      const { html } = await navigateWithRetry(UC_HOME);
      const $ = load(html);

      const logoutLink = $('a[href*="login.php?do=logout"]');
      const loggedIn = logoutLink.length > 0;

      let username: string | undefined;
      if (loggedIn) {
        // Try common vBulletin welcome selectors
        const welcomeEl = $("#welcomelink, .welcomelink, #userlinks .bolds").first();
        const welcomeText = welcomeEl.text().trim();
        const match = welcomeText.match(/Welcome,?\s+(.+)/i);
        if (match) {
          username = match[1].replace(/[!.]+$/, "").trim();
        } else {
          // Fallback: grab username from user CP link text
          username = $('a[href*="usercp.php"]').first().text().trim() || undefined;
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ loggedIn, username }) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });
}
