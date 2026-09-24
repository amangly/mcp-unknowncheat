import { connect } from "puppeteer-real-browser";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_PATH = path.join(__dirname, "..", "cookies.json");
const CLOUDFLARE_INDICATORS = ["Just a moment", "cf-browser-verification", "Checking your browser"];
const NAV_TIMEOUT = 30_000;
const NAV_TIMEOUT_RETRY = 60_000;
const CF_WAIT_MS = Number(process.env.UC_CF_WAIT_MS ?? 15_000);

function useRealDisplay(): boolean {
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
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
  const { browser, page } = await connect({
    headless: false,
    turnstile: true,
    args: onWayland ? ["--ozone-platform=wayland", "--start-maximized"] : ["--start-maximized"],
    customConfig: {},
    connectOption: {
      defaultViewport: null,
    },
    disableXvfb: useRealDisplay(),
  });

  browser.on("disconnected", () => {
    console.error("[browser] Browser disconnected");
    instance = null;
  });

  await loadCookies(page);
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

  const attempt = async (timeout: number, waitUntil: "networkidle2" | "domcontentloaded" = "networkidle2"): Promise<string> => {
    await page.goto(url, { waitUntil, timeout: remaining(timeout) });

    let html = await page.content();

    if (hasCloudflareChallenge(html)) {
      console.error("[browser] Cloudflare challenge detected, waiting", CF_WAIT_MS, "ms...");
      await new Promise((res) => setTimeout(res, remaining(CF_WAIT_MS)));
      remaining(1);
      html = await page.content();

      if (hasCloudflareChallenge(html)) {
        throw new Error("CloudflareBlockError: Challenge did not resolve after waiting");
      }
    }

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
