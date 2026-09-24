import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getPage, navigateWithRetry, validateUrl } from "../browser.js";
import path from "path";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = path.join(__dirname, "..", "..", "downloads");
const MAX_WAIT_MS = 120_000;
const POLL_MS = 1_000;
const MAX_FILE_PREVIEW = 50_000; // chars per file for analysis
const MAX_TOTAL_CONTENT = 300_000; // total chars budget for all analyzed files
const MAX_FILES_ANALYZE = 50;

// Known third-party / vendored directories to skip during analysis
const SKIP_DIRS = new Set([
  "imgui", "imgui-master", "dear-imgui",
  "stb", "glad", "glfw", "glew", "sdl",
  "json", "nlohmann", "rapidjson",
  "boost", "eigen", "glm",
  "node_modules", ".git", "__pycache__",
  "packages", "vendor", "third_party", "thirdparty", "3rdparty", "external", "deps", "lib",
]);

interface FileEntry {
  path: string;
  size: number;
  extension: string;
}

interface AnalyzedFile {
  path: string;
  size: number;
  extension: string;
  content?: string;
  binary?: boolean;
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".xml", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf",
  ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx",
  ".cs", ".java", ".kt", ".scala",
  ".py", ".rb", ".lua", ".pl", ".php",
  ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
  ".html", ".htm", ".css", ".scss", ".less",
  ".rs", ".go", ".swift", ".m", ".mm",
  ".sh", ".bash", ".bat", ".cmd", ".ps1",
  ".asm", ".s", ".inc",
  ".sln", ".csproj", ".vcxproj", ".props", ".targets",
  ".cmake", ".makefile", ".mk",
  ".gitignore", ".editorconfig", ".env.example",
  ".log", ".csv", ".sql",
]);

function isTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (["makefile", "cmakelists.txt", "dockerfile", "readme", "license", "changelog"].includes(base)) return true;
  return false;
}

function isThirdParty(filePath: string): boolean {
  const parts = filePath.toLowerCase().split(/[\\/]/);
  return parts.some(p => SKIP_DIRS.has(p));
}

async function validateExtractedPaths(destDir: string): Promise<void> {
  const resolvedDest = path.resolve(destDir);
  const files = await listFilesRecursive(destDir);
  for (const f of files) {
    const fullPath = path.resolve(destDir, f.path);
    if (!fullPath.startsWith(resolvedDest)) {
      // Remove the offending file and throw
      await rm(fullPath, { force: true }).catch(() => {});
      throw new Error(`Zip-Slip detected: "${f.path}" escapes extraction directory`);
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function listFilesRecursive(dir: string, base: string = ""): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items) {
    const rel = base ? `${base}/${item.name}` : item.name;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      entries.push(...await listFilesRecursive(full, rel));
    } else {
      const s = await stat(full);
      entries.push({ path: rel, size: s.size, extension: path.extname(item.name).toLowerCase() });
    }
  }
  return entries;
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  // Use PowerShell Expand-Archive (safe: args are passed as separate parameters, not interpolated)
  const ps = Bun.spawn(
    ["powershell", "-NoProfile", "-Command",
      "Expand-Archive", "-Path", zipPath, "-DestinationPath", destDir, "-Force"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const psExit = await ps.exited;
  if (psExit !== 0) {
    // Fallback: try tar
    const proc = Bun.spawn(["tar", "-xf", zipPath, "-C", destDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error("Failed to extract zip");
    }
  }
}

async function extractRar(filePath: string, destDir: string): Promise<void> {
  // Try unrar or 7z
  let proc = Bun.spawn(["unrar", "x", "-o+", filePath, destDir], {
    stdout: "pipe", stderr: "pipe",
  });
  let exitCode = await proc.exited;
  if (exitCode !== 0) {
    proc = Bun.spawn(["7z", "x", `-o${destDir}`, "-y", filePath], {
      stdout: "pipe", stderr: "pipe",
    });
    exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error("Failed to extract .rar — install unrar or 7-Zip and ensure it's in PATH");
    }
  }
}

async function extract7z(filePath: string, destDir: string): Promise<void> {
  const proc = Bun.spawn(["7z", "x", `-o${destDir}`, "-y", filePath], {
    stdout: "pipe", stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error("Failed to extract .7z — install 7-Zip and ensure it's in PATH");
  }
}

export function registerDownloadFile(server: McpServer): void {
  server.tool(
    "download_file",
    "Download a file attachment from UnknownCheats, extract archives (zip/rar/7z), and analyze contents. Returns file tree and text file previews.",
    {
      url: z.string().url().describe("Direct download URL or UC attachment page URL"),
      analyze: z
        .boolean()
        .optional()
        .default(true)
        .describe("If true, reads and returns text file contents for analysis (default true)"),
    },
    async ({ url, analyze }) => {
      try {
        validateUrl(url);
        await mkdir(DOWNLOADS_DIR, { recursive: true });

        // Clean previous downloads
        const oldFiles = await readdir(DOWNLOADS_DIR);
        for (const f of oldFiles) {
          await rm(path.join(DOWNLOADS_DIR, f), { recursive: true, force: true });
        }

        let page = await getPage();

        // Set download behavior to our downloads folder
        const client = await page.createCDPSession();
        await client.send("Browser.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: DOWNLOADS_DIR,
          eventsEnabled: true,
        });

        console.error(`[download] Navigating to: ${url}`);

        // Detect URL type
        const isDirectAttachment = /attachment\.php|attachmentid=/.test(url);
        const isDownloadsPage = /downloads\.php\?do=file/.test(url);

        if (isDirectAttachment) {
          // Direct attachment — navigate triggers download
          await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 }).catch(() => {
            // Navigation may "fail" because it's a download, not a page
          });
        } else if (isDownloadsPage) {
          // UC downloads page — navigate, then find the "act=down&actionhash=" link
          const navResult = await navigateWithRetry(url);
          page = navResult.page;

          // UC download links have pattern: downloads.php?do=file&id=XXXX&act=down&actionhash=YYYY
          const downloadLink = await page.evaluate(() => {
            const selectors = [
              'a[href*="act=down"]',
              'a[href*="act=down&actionhash"]',
              'a[title*="Download"]',
              'a[href*="attachment.php"]',
            ];
            for (const sel of selectors) {
              const el = document.querySelector(sel) as HTMLAnchorElement | null;
              if (el?.href) return el.href;
            }
            return null;
          });

          if (downloadLink) {
            console.error(`[download] Found UC download link: ${downloadLink}`);
            // Navigate to the download link — this triggers the actual file download
            await page.goto(downloadLink, { waitUntil: "networkidle2", timeout: 30_000 }).catch(() => {
              // Expected — download navigation doesn't resolve to a page
            });
          } else {
            // Debug: show what links are on the page
            const pageLinks = await page.evaluate(() => {
              return Array.from(document.querySelectorAll("a[href]"))
                .filter(a => (a as HTMLAnchorElement).href.includes("download") || (a as HTMLAnchorElement).href.includes("act="))
                .slice(0, 15)
                .map(a => ({
                  text: (a as HTMLAnchorElement).textContent?.trim().slice(0, 80),
                  href: (a as HTMLAnchorElement).href,
                }));
            });
            return {
              content: [{ type: "text", text: JSON.stringify({ error: "No download link found on UC downloads page", page_links_sample: pageLinks }, null, 2) }],
              isError: true,
            };
          }
        } else {
          // Generic page — navigate and look for attachment/download links
          const navResult = await navigateWithRetry(url);
          page = navResult.page;

          const attachmentUrl = await page.evaluate(() => {
            const link = document.querySelector('a[href*="attachment.php"]') as HTMLAnchorElement | null;
            return link?.href ?? null;
          });

          if (attachmentUrl) {
            console.error(`[download] Found attachment link: ${attachmentUrl}`);
            await page.goto(attachmentUrl, { waitUntil: "networkidle2", timeout: 30_000 }).catch(() => {});
          } else {
            const clicked = await page.evaluate(() => {
              const btn = document.querySelector('a[href*="do=get"], a.download, a[download]') as HTMLAnchorElement | null;
              if (btn) { btn.click(); return true; }
              return false;
            });

            if (!clicked) {
              return {
                content: [{ type: "text", text: "Error: No downloadable file found on this page. Provide a direct attachment URL (containing attachment.php or attachmentid=)." }],
                isError: true,
              };
            }
          }
        }

        // Wait for download to complete
        console.error("[download] Waiting for download to complete...");
        let downloadedFile: string | null = null;
        const start = Date.now();

        while (Date.now() - start < MAX_WAIT_MS) {
          await new Promise(r => setTimeout(r, POLL_MS));
          const files = await readdir(DOWNLOADS_DIR);
          // Filter out .crdownload / .part / .tmp partial files
          const completed = files.filter(f =>
            !f.endsWith(".crdownload") &&
            !f.endsWith(".part") &&
            !f.endsWith(".tmp") &&
            !f.startsWith(".")
          );
          if (completed.length > 0) {
            downloadedFile = completed[0];
            // Wait a bit more to ensure write is complete
            await new Promise(r => setTimeout(r, 1_500));
            break;
          }
        }

        await client.detach();

        if (!downloadedFile) {
          return {
            content: [{ type: "text", text: "Error: Download timed out or no file was received." }],
            isError: true,
          };
        }

        const downloadedPath = path.join(DOWNLOADS_DIR, downloadedFile);
        const fileStat = await stat(downloadedPath);
        const ext = path.extname(downloadedFile).toLowerCase();

        console.error(`[download] Downloaded: ${downloadedFile} (${formatSize(fileStat.size)})`);

        const result: Record<string, unknown> = {
          file: downloadedFile,
          size: formatSize(fileStat.size),
          type: ext || "unknown",
        };

        // Extract if archive
        const isArchive = [".zip", ".rar", ".7z"].includes(ext);
        let extractedDir: string | null = null;

        if (isArchive) {
          extractedDir = path.join(DOWNLOADS_DIR, "extracted");
          await mkdir(extractedDir, { recursive: true });

          console.error(`[download] Extracting ${ext} archive...`);

          if (ext === ".zip") {
            await extractZip(downloadedPath, extractedDir);
          } else if (ext === ".rar") {
            await extractRar(downloadedPath, extractedDir);
          } else if (ext === ".7z") {
            await extract7z(downloadedPath, extractedDir);
          }

          // Validate no path traversal in extracted files
          await validateExtractedPaths(extractedDir);

          const fileList = await listFilesRecursive(extractedDir);
          result.extracted = true;
          result.file_count = fileList.length;
          result.total_size = formatSize(fileList.reduce((sum, f) => sum + f.size, 0));

          // Build file tree
          const tree = fileList.map(f => `${f.path} (${formatSize(f.size)})`);
          result.file_tree = tree;

          // Extension stats
          const extCounts: Record<string, number> = {};
          for (const f of fileList) {
            const e = f.extension || "(none)";
            extCounts[e] = (extCounts[e] ?? 0) + 1;
          }
          result.extension_stats = extCounts;

          // Analyze text files (skip third-party/vendored code)
          if (analyze) {
            const analyzed: AnalyzedFile[] = [];
            const allTextFiles = fileList.filter(f => isTextFile(f.path));
            const projectFiles = allTextFiles.filter(f => !isThirdParty(f.path));
            const skippedFiles = allTextFiles.filter(f => isThirdParty(f.path));
            const textFiles = projectFiles.slice(0, MAX_FILES_ANALYZE);

            let totalContent = 0;
            for (const f of textFiles) {
              if (totalContent >= MAX_TOTAL_CONTENT) {
                analyzed.push({
                  path: f.path,
                  size: f.size,
                  extension: f.extension,
                  content: `[skipped — content budget exhausted (${formatSize(MAX_TOTAL_CONTENT)} total)]`,
                });
                continue;
              }
              const fullPath = path.join(extractedDir, f.path);
              try {
                const raw = await readFile(fullPath, "utf-8");
                const preview = raw.length > MAX_FILE_PREVIEW
                  ? raw.slice(0, MAX_FILE_PREVIEW) + `\n... [truncated, ${raw.length} chars total]`
                  : raw;
                totalContent += preview.length;
                analyzed.push({
                  path: f.path,
                  size: f.size,
                  extension: f.extension,
                  content: preview,
                });
              } catch {
                analyzed.push({
                  path: f.path,
                  size: f.size,
                  extension: f.extension,
                  binary: true,
                });
              }
            }

            result.analyzed_files = analyzed;
            result.analyzed_count = analyzed.length;
            result.total_content_chars = totalContent;

            if (skippedFiles.length > 0) {
              result.skipped_third_party = skippedFiles.map(f => f.path);
              result.skipped_note = `${skippedFiles.length} third-party/library files skipped (imgui, etc.). Only project source files are analyzed.`;
            }

            if (projectFiles.length > MAX_FILES_ANALYZE) {
              result.analysis_note = `Showing ${textFiles.length} of ${projectFiles.length} project text files (capped at ${MAX_FILES_ANALYZE})`;
            }
          }
        } else if (analyze && isTextFile(downloadedFile)) {
          // Single text file — just read it
          const raw = await readFile(downloadedPath, "utf-8");
          result.content = raw.length > MAX_FILE_PREVIEW
            ? raw.slice(0, MAX_FILE_PREVIEW) + `\n... [truncated, ${raw.length} chars total]`
            : raw;
        } else {
          result.note = "File downloaded but not a recognized archive or text file. Check the downloads folder.";
          result.downloads_path = DOWNLOADS_DIR;
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
