/**
 * ntnkit ci-smoke — minimal end-to-end check.
 *
 * Local:
 *   pnpm --filter @ntnkit/example-ci-smoke start
 *
 * Live HTTP against a local echo server (no external deps):
 *   SMOKE_LIVE=1 pnpm --filter @ntnkit/example-ci-smoke start
 *
 * Under ntn-in-a-box (from ntn-in-a-box repo root):
 *   ntnbox run --profile ../ntnkit/test/profiles/leo_pass_90s.yaml -- \
 *     pnpm --dir ../ntnkit/examples/ci-smoke start
 */
import { createServer, type Server } from "node:http";
import { DeliveryMode, LinkState, Priority } from "@ntnkit/core";
import { connect, httpTransport } from "@ntnkit/sdk";

const simulateWindow =
  process.env.NTNKIT_SIMULATE_WINDOW === "1" ||
  process.env.NTNKIT_SIMULATE_WINDOW === "true";
const liveHttp =
  process.env.SMOKE_LIVE === "1" || process.env.SMOKE_LIVE === "true";

async function startEchoServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("failed to bind echo server");
  }
  return { server, url: `http://127.0.0.1:${addr.port}/` };
}

async function main(): Promise<void> {
  let linkState = simulateWindow
    ? LinkState.Constrained
    : LinkState.Terrestrial;

  let echo: { server: Server; url: string } | undefined;
  if (liveHttp) {
    echo = await startEchoServer();
  }

  try {
    const client = await connect({
      budget: { dailyBytes: 50_000 },
      transport: liveHttp
        ? httpTransport({
            url: echo!.url,
            linkState: async () => linkState,
            timeoutMs: 5_000,
          })
        : {
            name: "mock",
            getLinkState: async () => linkState,
            async send() {
              return { delivered: true, latencyMs: 1 };
            },
          },
    });

    const payload = new TextEncoder().encode(
      JSON.stringify({ hello: "ntnkit", ts: Date.now() }),
    );

    if (simulateWindow) {
      await client.send({
        payload,
        priority: Priority.Normal,
        delivery: DeliveryMode.NextWindow,
        dedupKey: "ci-smoke",
      });

      const queued = client.stats().outbox.depth;
      if (queued !== 1) {
        throw new Error(`expected 1 queued message, got ${queued}`);
      }

      linkState = LinkState.SatelliteWindowOpen;
      const { sent } = await client.flush();
      if (sent !== 1) {
        throw new Error(`expected flush to send 1 message, sent ${sent}`);
      }
    } else {
      await client.send({
        payload,
        delivery: DeliveryMode.Immediate,
        dedupKey: "ci-smoke",
      });
      if (client.stats().outbox.depth !== 0) {
        throw new Error("expected immediate delivery with empty outbox");
      }
    }

    console.log("ci-smoke: ok");
  } finally {
    if (echo) {
      await new Promise<void>((resolve, reject) => {
        echo!.server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
}

main().catch((err) => {
  console.error("ci-smoke: failed", err);
  process.exit(1);
});
