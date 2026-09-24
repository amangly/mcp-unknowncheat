import { connect } from "puppeteer-real-browser";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_PATH = path.join(__dirname, "..", "cookies.json");
const DATA_DIR = process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "mcp-unknowncheat")
  : path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "mcp-unknowncheat");
const PROFILE_DIR = process.env.UC_PROFILE_DIR ?? path.join(DATA_DIR, "chrome-profile");
const CLOUDFLARE_INDICATORS = ["Just a moment", "cf-browser-verification", "Checking your browser"];
const NAV_TIMEOUT = 30_000;
const NAV_TIMEOUT_RETRY = 60_000;
const CF_WAIT_MS = Number(process.env.UC_CF_WAIT_MS ?? 45_000);

function useRealDisplay(): boolean {
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function useHeadless(): boolean {
  return process.env.UC_HEADLESS === "1" || (process.platform !== "win32" && !useRealDisplay());
}

const ALLOWED_HOSTS = new Set(["www.unknowncheats.me", "unknowncheats.me"]);

export function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Blocked URL scheme: ${parsed.protocol} — only http/https allowed`);
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Blocked URL host: ${parsed.hostname} — only unknowncheats.me is allowed`);
  }
}

type BrowserInstance = {
  browser: Awaited<ReturnType<typeof connect>>["browser"];
  page: Awaited<ReturnType<typeof connect>>["page"];
};

let instance: BrowserInstance | null = null;
let sessionTail: Promise<void> = Promise.resolve();

// A tool owns the shared page until its whole workflow finishes. A navigation-only
// lock would still let another tool replace the page before evaluate()/content().
export function withBrowserSession<T>(operation: () => Promise<T>, maxQueueWaitMs = 10_000): Promise<T> {
  let started = false;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout>;
  const queueTimeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (started) return;
      cancelled = true;
      reject(new Error(`Browser busy: queue wait exceeded ${maxQueueWaitMs} ms`));
    }, maxQueueWaitMs);
  });
  const result = sessionTail.then(() => {
    if (cancelled) throw new Error("Browser session request cancelled while queued");
    started = true;
    clearTimeout(timer);
    return operation();
  });
  sessionTail = result.then(() => undefined, () => undefined);
  return Promise.race([result, queueTimeout]);
}

async function loadCookies(page: BrowserInstance["page"]): Promise<void> {
  try {
    const file = Bun.file(COOKIES_PATH);
    if (await file.exists()) {
      const cookies = await file.json();
      if (Array.isArray(cookies) && cookies.length > 0) {
        await page.setCookie(...cookies);
        console.error("[browser] Loaded cookies from", COOKIES_PATH);
      }
    }
  } catch (err) {
    console.error("[browser] Cookie load failed (starting fresh):", err);
  }
}

async function saveCookies(page: BrowserInstance["page"]): Promise<void> {
  try {
    const cookies = await page.cookies();
    await Bun.write(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  } catch (err) {
    console.error("[browser] Cookie save failed:", err);
  }
}

async function launchBrowser(): Promise<BrowserInstance> {
  console.error("[browser] Launching Chrome...");
  const onWayland = process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY;
  const executablePath = process.env.UC_CHROME_PATH?.trim();
  const existingProfile = existsSync(PROFILE_DIR);
  mkdirSync(PROFILE_DIR, { recursive: true });
  const { browser, page } = await connect({
    headless: useHeadless(),
    turnstile: true,
    args: onWayland ? ["--ozone-platform=wayland", "--start-maximized"] : ["--start-maximized"],
    customConfig: {
      ...(executablePath ? { chromePath: executablePath } : {}),
      userDataDir: PROFILE_DIR,
    },
    connectOption: { defaultViewport: null },
    disableXvfb: useRealDisplay(),
  });

  browser.on("disconnected", () => {
    console.error("[browser] Browser disconnected");
    instance = null;
  });

  if (!existingProfile) await loadCookies(page);
  return { browser, page };
}

export async function getPage(): Promise<BrowserInstance["page"]> {
  if (!instance) {
    instance = await launchBrowser();
  }
  return instance.page;
}

export async function ensureFreshBrowser(): Promise<BrowserInstance["page"]> {
  if (instance) {
    try {
      await instance.browser.close();
    } catch {
      // ignore — may already be dead
    }
    instance = null;
  }
  instance = await launchBrowser();
  return instance.page;
}

function hasCloudflareChallenge(html: string): boolean {
  return CLOUDFLARE_INDICATORS.some((indicator) => html.includes(indicator));
}

function isPendingPage(html: string): boolean {
  return html.length < 200 || hasCloudflareChallenge(html);
}

async function waitForChallenge(page: BrowserInstance["page"], initialHtml: string, deadlineAt?: number): Promise<string> {
  if (!isPendingPage(initialHtml)) return initialHtml;
  if (useHeadless()) {
    throw new Error("CloudflareBlockError: A challenge appeared in headless Chrome. Use visible Chrome to complete it manually.");
  }
  const waitMs = Number.isFinite(CF_WAIT_MS) ? Math.max(0, CF_WAIT_MS) : 45_000;
  const stopAt = Math.min(Date.now() + waitMs, deadlineAt ?? Infinity);
  console.error(`[browser] Cloudflare challenge: complete it in the visible Chrome window (up to ${Math.ceil((stopAt - Date.now()) / 1000)} seconds).`);
  while (Date.now() < stopAt) {
    await Bun.sleep(Math.min(1_000, stopAt - Date.now()));
    try {
      const html = await page.content();
      if (!isPendingPage(html)) return html;
    } catch (error) {
      if (!isDetachedError(error)) throw error;
    }
  }
  throw new Error("CloudflareBlockError: Challenge stayed open in Chrome. Complete it manually or use forum-supported access; this server cannot guarantee automated clearance.");
}

function isDetachedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes("Detached Frame") ||
    msg.includes("Execution context was destroyed") ||
    msg.includes("Target closed") ||
    msg.includes("Session closed")
  );
}

function isNavigationAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("ERR_ABORTED") || err.message.includes("Navigation failed");
}

export async function navigateWithRetry(url: string, deadlineAt?: number): Promise<{ page: BrowserInstance["page"]; html: string }> {
  validateUrl(url);
  let page = await getPage();
  let navRetried = false;
  let detachedRetried = false;

  const remaining = (maximum: number): number => {
    if (deadlineAt === undefined) return maximum;
    const left = deadlineAt - Date.now();
    if (left <= 0) throw new Error("Browser operation time budget exhausted");
    return Math.max(1, Math.min(maximum, left));
  };

  const attempt = async (timeout: number, waitUntil: "networkidle2" | "domcontentloaded" = "domcontentloaded"): Promise<string> => {
    await page.goto(url, { waitUntil, timeout: remaining(timeout) });

    const html = await waitForChallenge(page, await page.content(), deadlineAt);
    remaining(1);

    await saveCookies(page);
    return html;
  };

  try {
    const html = await attempt(NAV_TIMEOUT);
    return { page, html };
  } catch (err) {
    if (isNavigationAbortError(err) && !navRetried) {
      console.error("[browser] Navigation aborted (often ads), retrying with domcontentloaded...");
      navRetried = true;
      const html = await attempt(NAV_TIMEOUT_RETRY, "domcontentloaded");
      return { page, html };
    }
    if (isDetachedError(err) && !detachedRetried) {
      console.error("[browser] Detached frame error, relaunching browser and retrying...");
      detachedRetried = true;
      page = await ensureFreshBrowser();
      const html = await attempt(NAV_TIMEOUT_RETRY);
      return { page, html };
    }
    throw err;
  }
}

export async function closeBrowser(): Promise<void> {
  if (instance) {
    try {
      await instance.browser.close();
    } catch {
      // ignore
    }
    instance = null;
  }
}
