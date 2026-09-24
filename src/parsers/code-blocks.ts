import { load } from "cheerio";
import type { CodeBlock } from "../types.js";

const CPP_PATTERNS = [/#include\s*[<"]/, /\bstd::/, /\bnullptr\b/, /\bcout\b/, /\bcin\b/, /\bvoid\s+\w+\s*\(/, /\bconstexpr\b/, /\bDWORD\b/, /\buint64_t\b/, /\buint32_t\b/, /#define\s+\w+/, /\bULONG\b/, /\bINT64\b/];
const CSHARP_PATTERNS = [/\busing\s+System\b/, /\bnamespace\s+\w+/, /\bpublic\s+class\b/, /Console\.Write/];
const PYTHON_PATTERNS = [/\bdef\s+\w+\s*\(/, /\bimport\s+\w+/, /\bprint\s*\(/, /\bself\./, /\b__init__\b/];
const LUA_PATTERNS = [/\bfunction\s+\w+\s*\(/, /\blocal\s+\w+/, /\brequire\s*\(/, /\bend\b/];

function detectLanguage(code: string, cssClass?: string): string {
  if (cssClass) {
    const cls = cssClass.toLowerCase();
    if (cls.includes("cpp") || cls.includes("c++")) return "cpp";
    if (cls.includes("csharp") || cls.includes("c#")) return "csharp";
    if (cls.includes("python") || cls.includes("py")) return "python";
    if (cls.includes("lua")) return "lua";
  }

  const score = (patterns: RegExp[]) => patterns.filter((p) => p.test(code)).length;

  const scores: [string, number][] = [
    ["cpp", score(CPP_PATTERNS)],
    ["csharp", score(CSHARP_PATTERNS)],
    ["python", score(PYTHON_PATTERNS)],
    ["lua", score(LUA_PATTERNS)],
  ];

  const best = scores.reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[1] > 0 ? best[0] : "unknown";
}

export function parseCodeBlocks(html: string): CodeBlock[] {
  const $ = load(html);
  const blocks: CodeBlock[] = [];
  const seen = new Set<string>();

  // vBulletin highlight blocks, pre, and code tags
  $(".highlight, pre, code").each((_, el) => {
    const element = $(el);
    const code = element.text().trim();

    if (!code || code.length < 10 || seen.has(code)) return;
    seen.add(code);

    const cssClass = element.attr("class") ?? "";
    const language = detectLanguage(code, cssClass);

    // Grab surrounding context (previous sibling text, up to 100 chars)
    const contextEl = element.prev();
    const context = contextEl.length ? contextEl.text().trim().slice(0, 100) : undefined;

    // Find ancestor post ID (vBulletin: table[id^='post'])
    const postAncestor = element.closest("table[id]").filter((_, el) => /^post\d+$/.test($(el).attr("id") ?? ""));
    const postId = postAncestor.length ? postAncestor.attr("id") : undefined;

    blocks.push({ code, language, context, postId });
  });

  return blocks;
}
