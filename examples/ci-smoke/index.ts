/**
 * ntnkit ci-smoke — minimal end-to-end check.
 *
 * Local:
 *   pnpm --filter @ntnkit/example-ci-smoke start
 *
 * Live HTTP against a local echo server (no external deps):
 *   SMOKE_LIVE=1 pnpm --filter @ntnkit/example-ci-smoke start
 *
 * Simulated window (no ntnbox):
 *   NTNKIT_SIMULATE_WINDOW=1 pnpm --filter @ntnkit/example-ci-smoke start
 *
 * Under ntn-in-a-box (from ntn-in-a-box repo root):
 *   ./ntnbox run --addr 0.0.0.0:18080 \
 *     --profile ../ntnkit/test/profiles/ci_gap.yaml -- \
 *     env NTNBOX_API_BASE=http://10.200.0.1:18080 \
 *     ../ntnkit/scripts/ntnbox-ci-smoke.sh
 */
import { createServer, type Server } from "node:http";
import {
  DEFAULT_POLICY,
  DeliveryMode,
  DeliveryStage,
  LinkState,
  Priority,
} from "@ntnkit/core";
import {
  connect,
  httpTransport,
  ntnboxLinkState,
  type Transport,
} from "@ntnkit/sdk";

const simulateWindow =
  process.env.NTNKIT_SIMULATE_WINDOW === "1" ||
  process.env.NTNKIT_SIMULATE_WINDOW === "true";
const liveHttp =
  process.env.SMOKE_LIVE === "1" || process.env.SMOKE_LIVE === "true";
const ntnboxApiBase = process.env.NTNBOX_API_BASE?.trim() || undefined;
const ntnboxDeviceId = process.env.NTNBOX_DEVICE_ID?.trim() || "sandbox-0";
const waitTimeoutMs = Number(process.env.NTNKIT_SMOKE_TIMEOUT_MS ?? 120_000);

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLinkState(
  getState: () => Promise<LinkState>,
  want: LinkState,
  label: string,
): Promise<void> {
  const deadline = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline) {
    const state = await getState();
    if (state === want) return;
    await sleep(200);
  }
  throw new Error(
    `timeout waiting for ${label} (${want}) after ${waitTimeoutMs}ms`,
  );
}

async function waitForDurableGap(
  getState: () => Promise<LinkState>,
  apiBase: string,
  deviceId: string,
): Promise<void> {
  const minGapSec = 5;
  const deadline = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline) {
    const state = await getState();
    if (state !== LinkState.Constrained) {
      await sleep(200);
      continue;
    }

    const res = await fetch(
      `${apiBase.replace(/\/+$/, "")}/devices/${encodeURIComponent(deviceId)}/condition`,
      { headers: { accept: "application/json" } },
    );
    if (!res.ok) {
      await sleep(200);
      continue;
    }
    const body = (await res.json()) as {
      in_coverage?: unknown;
      until_next_transition_sec?: unknown;
    };
    if (
      body.in_coverage === false &&
      typeof body.until_next_transition_sec === "number" &&
      body.until_next_transition_sec >= minGapSec
    ) {
      return;
    }
    await sleep(200);
  }
  throw new Error(
    `timeout waiting for durable coverage gap after ${waitTimeoutMs}ms`,
  );
}

function countingTransport(inner: Transport): {
  transport: Transport;
  sendAttempts: () => number;
} {
  let sendAttempts = 0;
  return {
    sendAttempts: () => sendAttempts,
    transport: {
      name: inner.name,
      getLinkState: () => inner.getLinkState(),
      async send(message) {
        sendAttempts += 1;
        return inner.send(message);
      },
    },
  };
}

async function runNtnboxAcceptance(): Promise<void> {
  const apiBase = ntnboxApiBase!;
  const echo = await startEchoServer();
  const link = ntnboxLinkState({
    apiBaseUrl: apiBase,
    deviceId: ntnboxDeviceId,
    pollIntervalMs: 500,
  });
  const delivered: string[] = [];

  try {
    const base = httpTransport({
      url: echo.url,
      linkState: () => link.getLinkState(),
      timeoutMs: 5_000,
    });
    const { transport, sendAttempts } = countingTransport(base);
    const client = await connect({
      budget: { dailyBytes: 50_000 },
      transport,
      autoFlush: { intervalMs: 200 },
      onStatus: (event) => {
        if (event.stage === DeliveryStage.Delivered) {
          delivered.push(event.id);
        }
      },
    });

    try {
      await waitForDurableGap(
        () => link.getLinkState(),
        apiBase,
        ntnboxDeviceId,
      );

      const payload = new TextEncoder().encode(
        JSON.stringify({ hello: "ntnkit", ts: Date.now() }),
      );
      await client.send({
        payload,
        priority: Priority.Normal,
        delivery: DeliveryMode.NextWindow,
        dedupKey: "ci-smoke-ntnbox",
      });

      if ((await client.stats()).outbox.depth !== 1) {
        throw new Error(
          `expected 1 queued message while closed, got ${(await client.stats()).outbox.depth}`,
        );
      }
      if (sendAttempts() !== 0) {
        throw new Error(
          `expected 0 send attempts while closed, got ${sendAttempts()}`,
        );
      }

      await waitForLinkState(
        () => link.getLinkState(),
        LinkState.SatelliteWindowOpen,
        "coverage open",
      );

      // autoFlush drains — no manual flush() on the normal path.
      const deadline = Date.now() + waitTimeoutMs;
      while (Date.now() < deadline) {
        if (
          delivered.length === 1 &&
          (await client.stats()).outbox.depth === 0
        ) {
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (delivered.length !== 1) {
        throw new Error(`expected 1 delivered event, got ${delivered.length}`);
      }
      if ((await client.stats()).outbox.depth !== 0) {
        throw new Error("expected empty outbox after autoFlush delivery");
      }
      if (sendAttempts() < 1) {
        throw new Error("expected at least one transport send after open");
      }
      if (sendAttempts() > DEFAULT_POLICY.maxAttemptsPerWindow) {
        throw new Error(
          `send attempts ${sendAttempts()} exceed maxAttemptsPerWindow ${DEFAULT_POLICY.maxAttemptsPerWindow}`,
        );
      }

      console.log(
        JSON.stringify({
          ok: true,
          mode: "ntnbox",
          sendAttempts: sendAttempts(),
          delivered: delivered.length,
          autoFlush: true,
        }),
      );
      console.log("ci-smoke: ok");
    } finally {
      await client.close();
    }
  } finally {
    await link.close();
    await new Promise<void>((resolve, reject) => {
      echo.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function runLocalSmoke(): Promise<void> {
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

      const queued = (await client.stats()).outbox.depth;
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
      if ((await client.stats()).outbox.depth !== 0) {
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

async function main(): Promise<void> {
  if (ntnboxApiBase) {
    await runNtnboxAcceptance();
    return;
  }
  await runLocalSmoke();
}

main().catch((err) => {
  console.error("ci-smoke: failed", err);
  process.exit(1);
});
