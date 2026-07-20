/**
 * Messenger example.
 *
 *   pnpm --filter @ntnkit/example-messenger start
 *   NTNKIT_SIMULATE_WINDOW=1 pnpm --filter @ntnkit/example-messenger start
 */
import { DeliveryMode, LinkState, Priority } from "@ntnkit/core";
import { connect, httpTransport } from "@ntnkit/sdk";

const targetUrl = process.env.TARGET_URL ?? "https://httpbin.org/post";
const intervalMs = Number(process.env.SEND_INTERVAL_MS ?? 3000);
const simulateWindow =
  process.env.NTNKIT_SIMULATE_WINDOW === "1" ||
  process.env.NTNKIT_SIMULATE_WINDOW === "true";

async function main(): Promise<void> {
  let linkState = simulateWindow
    ? LinkState.Constrained
    : LinkState.Terrestrial;

  const client = await connect({
    budget: { dailyBytes: 50_000 },
    transport: httpTransport({
      url: targetUrl,
      timeoutMs: 15_000,
      linkState: async () => linkState,
    }),
    onStatus: ({ id, stage }) => {
      console.log(`status ${id.slice(0, 8)}… → ${stage}`);
    },
  });

  let n = 0;
  console.log(
    `messenger: sending to ${targetUrl} every ${intervalMs}ms` +
      (simulateWindow ? " (simulate window)" : ""),
  );

  while (true) {
    n += 1;
    const body = JSON.stringify({
      id: n,
      text: `message-${n}`,
      ts: Date.now(),
    });
    const payload = new TextEncoder().encode(body);

    if (simulateWindow) {
      linkState = LinkState.Constrained;
      await client.send({
        payload,
        priority: Priority.Normal,
        delivery: DeliveryMode.NextWindow,
        dedupKey: `msg-${n}`,
        contentType: "application/json",
      });
      linkState = LinkState.SatelliteWindowOpen;
      await client.flush();
    } else {
      await client.send({
        payload,
        priority: Priority.Normal,
        delivery: DeliveryMode.Immediate,
        dedupKey: `msg-${n}`,
        contentType: "application/json",
      });
    }

    const stats = await client.stats();
    console.log(
      `sent batch; outbox=${stats.outbox.depth} budget_left=${stats.budget.remainingBytes}`,
    );
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
