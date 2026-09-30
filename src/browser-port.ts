import { createServer } from "node:net";

// Give chrome-launcher an explicit port. Its dynamic-port discovery can read a
// stale DevTools entry from the persistent profile's append-only chrome-err.log.
// Release the reservation before Chrome binds; never expose debugging remotely.
export function getAvailableDebuggingPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string" || address.port === 0) {
        server.close(() => reject(new Error("Could not allocate Chrome debugging port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}
