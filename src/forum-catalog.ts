import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSubforums, type Subforum } from "./parsers/subforums.js";

export const FORUM_INDEX = "https://www.unknowncheats.me/forum/index.php";
const CATALOG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "forum-index.json");
const CATALOG_TTL_MS = 24 * 60 * 60_000;

export interface ForumCatalog {
  source: string;
  indexedAt: string;
  subforums: Subforum[];
}

export async function readForumCatalog(): Promise<ForumCatalog | null> {
  try {
    const catalog: ForumCatalog = await Bun.file(CATALOG_PATH).json();
    const age = Date.now() - Date.parse(catalog.indexedAt);
    if (catalog.source !== FORUM_INDEX || !Number.isFinite(age) || age < 0 || age > CATALOG_TTL_MS ||
        !Array.isArray(catalog.subforums) || !catalog.subforums.every((item) =>
          typeof item.slug === "string" && typeof item.label === "string" && typeof item.url === "string")) {
      return null;
    }
    return catalog;
  } catch {
    return null;
  }
}

export async function saveForumCatalog(html: string): Promise<ForumCatalog> {
  const subforums = parseSubforums(html);
  if (subforums.length === 0) throw new Error("Forum index contained no subforums");
  const catalog = { source: FORUM_INDEX, indexedAt: new Date().toISOString(), subforums };
  await Bun.write(CATALOG_PATH, JSON.stringify(catalog, null, 2));
  return catalog;
}
