import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { getAvailableDebuggingPort } from "../src/browser-port.ts";

test("Chrome receives a nonzero port released for its loopback listener", async () => {
  const port = await getAvailableDebuggingPort();
  expect(port).toBeGreaterThan(0);
  expect(port).toBeLessThanOrEqual(65535);
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    const address = server.address();
    expect(address).toEqual(expect.objectContaining({ address: "127.0.0.1", port }));
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
