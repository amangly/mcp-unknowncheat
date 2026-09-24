import { expect, test } from "bun:test";
import { withBrowserSession } from "../src/browser.ts";

test("browser sessions keep multi-step page work serialized", async () => {
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = withBrowserSession(async () => {
    events.push("first-start");
    await gate;
    events.push("first-end");
  });
  const second = withBrowserSession(async () => { events.push("second"); });
  await Bun.sleep(5);
  expect(events).toEqual(["first-start"]);
  release();
  await Promise.all([first, second]);
  expect(events).toEqual(["first-start", "first-end", "second"]);
});

test("timed-out queued browser work never runs later", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = withBrowserSession(async () => { await gate; });
  let entered = false;
  const second = withBrowserSession(async () => { entered = true; }, 5);
  await expect(second).rejects.toThrow("Browser busy");
  release();
  await first;
  expect(entered).toBe(false);
});
