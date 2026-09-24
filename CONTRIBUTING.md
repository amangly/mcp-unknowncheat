# Contributing to mcp-unknowncheat

This server reads UnknownCheats forum pages through a local Chrome session and exposes the results as MCP tools. Contributions that fix a reproducible failure, improve parser coverage, or make tool output easier to verify are welcome.

## Start here

You need [Bun](https://bun.sh) and Google Chrome or Chromium. Chrome is needed for live forum calls; the test suite runs locally without a forum account.

```sh
git clone https://github.com/amangly/mcp-unknowncheat.git
cd mcp-unknowncheat
bun install --frozen-lockfile
bun run typecheck
bun run test
```

Run `bun run start` to start the stdio MCP server. Connect it through an MCP client as shown in the [README](README.md#connect-an-mcp-client); it will wait for MCP messages on standard input. `bun run dev` restarts the server when source files change.

Read the [docs index](docs/README.md) for the code map and testing details. Small fixes and docs changes can go straight to a pull request. For a new tool, a change to the indexing model, or a change that adds network requests, open an issue first so the interface and request bounds can be discussed.

## Make a focused change

1. Reproduce the behavior. Include the tool name, inputs, expected result, actual result, and whether the page required login or a browser challenge. Remove credentials, cookies, and private account data from reports.
2. Change the layer that owns the behavior. Tool schemas and MCP responses live in `src/tools/`; navigation and request limits live in `src/browser.ts` and `src/crawl.ts`; HTML extraction lives in `src/parsers/`; persisted search lives in `src/forum-index.ts` and `src/sync-index.ts`.
3. Add a small fixture and a regression test when a parser, URL rule, freshness check, index update, or tool contract changes. Use synthetic or redacted HTML. See [testing](docs/contributing/testing.md).
4. Run `bun run typecheck` and `bun run test`. Run `bun run build` if you changed imports, the entry point, or packaging behavior. State any checks you could not run in the pull request.

Keep each pull request to one behavior change. Avoid formatting unrelated files or adding dependencies for a task the current stack can handle. Update the README when a public tool, option, configuration variable, or client setup step changes.

## Forum access and local data

The project connects only to `unknowncheats.me`. Keep URL validation in the fetch path when adding a tool. Preserve the existing request throttle, queue, and time budgets; a new crawl path must have a clear upper bound.

The Chrome profile, cookies, SQLite index, downloaded attachments, and HTML exports can contain account or forum data. Do not commit them or paste them into issues. Prefer a minimal synthetic HTML sample that reproduces the selector or pagination problem. If live access is necessary to verify a fix, describe exactly which pages and tool calls were checked, and distinguish that observation from the offline test result.

## Pull requests

Explain the user-visible change and how you verified it. For a forum parsing bug, include the page shape that failed and the new expected output. For a performance change, include before and after measurements for the same workload. The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) has a short checklist.

This project is licensed under [Apache-2.0](LICENSE). Contributions submitted for inclusion follow the license's contribution terms unless you state otherwise.
