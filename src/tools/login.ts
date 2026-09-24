import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { load } from "cheerio";
import { navigateWithRetry } from "../browser.js";
import { clearCache } from "../crawl.js";
import { isLoggedIn } from "../auth.js";

const UC_LOGIN = "https://www.unknowncheats.me/forum/login.php";

export function registerLogin(server: McpServer): void {
  server.tool(
    "login",
    "Log into UnknownCheats with username and password",
    {
      username: z.string().describe("UnknownCheats username"),
      password: z.string().describe("UnknownCheats password"),
    },
    async ({ username, password }) => {
      try {
        const { page } = await navigateWithRetry(UC_LOGIN);

        // Fill login form — vBulletin field names
        await page.type('input[name="vb_login_username"]', username, { delay: 60 });
        await page.type('input[name="vb_login_password"], input[type="password"]', password, { delay: 60 });

        // Submit
        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 }),
          page.click('input[type="submit"], button[type="submit"]'),
        ]);

        const html = await page.content();
        const $ = load(html);

        const loggedIn = isLoggedIn(html);

        if (!loggedIn) {
          // Check for error message
          const error = $(".error, .panel .error, #navbar_notice").first().text().trim();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ success: false, error: error || "Login failed — check credentials" }),
              },
            ],
            isError: true,
          };
        }

        clearCache();

        // Extract username from page to confirm
        const welcomeEl = $("#welcomelink, .welcomelink").first();
        const welcomeText = welcomeEl.text().trim();
        const match = welcomeText.match(/Welcome,?\s+(.+)/i);
        const confirmedUsername = match ? match[1].replace(/[!.]+$/, "").trim() : username;

        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, username: confirmedUsername }) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
