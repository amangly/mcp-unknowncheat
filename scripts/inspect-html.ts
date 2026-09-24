import { inspectForumHtml } from "../src/inspect-html.js";

const filename = process.argv[2];
if (!filename) {
  console.error("Usage: bun run inspect:html -- path/to/saved-page.html");
  process.exit(2);
}
const file = Bun.file(filename);
if (!await file.exists()) {
  console.error(`File not found: ${filename}`);
  process.exit(2);
}
if (file.size > 10_000_000) {
  console.error("HTML snapshot exceeds 10 MB");
  process.exit(2);
}
console.log(JSON.stringify(inspectForumHtml(await file.text()), null, 2));
