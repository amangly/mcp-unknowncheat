# Testing changes

Run these checks from the repository root:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

`bun run test` uses local HTML strings and injected fetchers. It does not require a forum login or a live Chrome session. `tests/parsers.test.ts` covers HTML and URL handling; `tests/thread-pages.test.ts` covers recent-page coverage; `tests/forum-index.test.ts` covers local search and sync; the other test files cover browser session ownership, offset discovery, and MCP routing.

For a changed parser, reduce the failing page to the smallest HTML fragment that still fails. Keep the element IDs, links, pagination, and surrounding markup needed to explain the case. Replace usernames, cookies, and unrelated post text. Add both the new failure case and a normal case if the fix could affect existing pages. A test should assert the returned behavior, including partial coverage or error state when relevant.

To inspect a saved page locally:

```sh
bun run inspect:html -- path/to/saved-forum-page.html
```

The inspector prints selector counts, parser coverage, pagination, and challenge markers. Do not commit the saved page unless it is synthetic or stripped of private data.

Live checks are useful for changes to Chrome navigation, login, and forum search. Use a small, named set of pages and record the tool calls, observed result, and any page that could not be fetched. A passing local fixture does not establish that Cloudflare, login, or a current forum layout worked during a live run. Conversely, a live result can be transient, so keep a local regression case for parser bugs.
