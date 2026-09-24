import type { CheerioAPI, Cheerio } from "cheerio";
import type { Element } from "domhandler";

export function extractTags($: CheerioAPI, titleElement: Cheerio<Element>): string[] {
  const tags: string[] = [];
  const TAG_PATTERN = /\[([^\]]+)\]/g;

  // Walk previous siblings for text nodes or elements containing [Tag]
  let prev = titleElement.prev();
  while (prev.length) {
    const text = prev.text().trim();
    for (const m of text.matchAll(TAG_PATTERN)) {
      tags.push(m[1]);
    }
    prev = prev.prev();
  }

  // Also check direct text nodes in the parent
  titleElement
    .parent()
    .contents()
    .filter(function () {
      return (this as unknown as { type: string }).type === "text";
    })
    .each((_, el) => {
      const text = $(el).text();
      for (const m of text.matchAll(TAG_PATTERN)) {
        tags.push(m[1]);
      }
    });

  return [...new Set(tags)];
}
