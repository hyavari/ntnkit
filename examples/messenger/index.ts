/**
 * Flagship messenger demo.
 *
 * Normal (terrestrial Immediate):
 *   pnpm --filter @ntnkit/example-messenger start
 *
 * Simulated satellite window + auto-flush (no manual flush):
 *   NTNKIT_SIMULATE_WINDOW=1 pnpm --filter @ntnkit/example-messenger start
 *
 * Durable outbox:
 *   OUTBOX_PATH=./messenger.db NTNKIT_SIMULATE_WINDOW=1 \
 *     pnpm --filter @ntnkit/example-messenger start
 *
 * Naïve before path (retry storm; no ntnkit):
 *   NAIVE=1 NTNKIT_SIMULATE_WINDOW=1 pnpm --filter @ntnkit/example-messenger start
 */
import { DeliveryMode, LinkState, Priority } from "@ntnkit/core";
import { connect, httpTransport } from "@ntnkit/sdk";
import { openSqliteStore } from "@ntnkit/sqlite";

const targetUrl = process.env.TARGET_URL ?? "https://httpbin.org/post";
const simulateWindow =
  process.env.NTNKIT_SIMULATE_WINDOW === "1" ||
  process.env.NTNKIT_SIMULATE_WINDOW === "true";
const naive =
  process.env.NAIVE === "1" || process.env.NAIVE === "true";
const outboxPath = process.env.OUTBOX_PATH?.trim();
const encoder = new TextEncoder();

async function runNaive(): Promise<void> {
  console.log(
    `messenger(naive): retrying POST to ${targetUrl} (no outbox / no budget)`,
  );
  let linkOpen = !simulateWindow;
  if (simulateWindow) {
    console.log("messenger(naive): waiting for simulated window…");
    await new Promise((r) => setTimeout(r, 500));
    linkOpen = true;
  }
  let attempts = 0;
  const body = encoder.encode(JSON.stringify({ text: "hello", large: false }));
  while (attempts < 20) {
    attempts += 1;
    if (simulateWindow && !linkOpen) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    try {
      const res = await fetch(targetUrl, { method: "POST", body });
      console.log(`naive attempt=${attempts} status=${res.status}`);
      if (res.ok) return;
    } catch (err) {
      console.log(`naive attempt=${attempts} error=${String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("naive path exhausted retries");
}

async function runNtnkit(): Promise<void> {
  let linkState = simulateWindow
    ? LinkState.Constrained
    : LinkState.Terrestrial;

  const store = outboxPath
    ? await openSqliteStore({ path: outboxPath })
    : undefined;

  const client = await connect({
    store,
    budget: { dailyBytes: 500 },
    autoFlush: simulateWindow ? { intervalMs: 200 } : true,
    transport: httpTransport({
      url: targetUrl,
      timeoutMs: 15_000,
      linkState: async () => linkState,
    }),
    onStatus: ({ id, stage }) => {
      console.log(`status ${id.slice(0, 8)}… → ${stage}`);
    },
  });

  const text = encoder.encode(
    JSON.stringify({ kind: "text", body: "hello from ntnkit", ts: Date.now() }),
  );
  // ~1.5 KiB — deferred when daily budget is tight / WhenBudgetAllows.
  const large = encoder.encode(
    JSON.stringify({
      kind: "attachment",
      note: "deferred until budget allows",
      blob: "x".repeat(1500),
      ts: Date.now(),
    }),
  );

  console.log(
    `messenger: text + large → ${targetUrl}` +
      (simulateWindow ? " (simulate window, autoFlush)" : " (autoFlush)") +
      (outboxPath ? ` outbox=${outboxPath}` : ""),
  );

  await client.send({
    payload: text,
    priority: Priority.High,
    delivery: simulateWindow
      ? DeliveryMode.NextWindow
      : DeliveryMode.Immediate,
    dedupKey: "msg-text",
    contentType: "application/json",
  });

  await client.send({
    payload: large,
    priority: Priority.Low,
    delivery: DeliveryMode.WhenBudgetAllows,
    dedupKey: "msg-large",
    contentType: "application/json",
  });

  if (simulateWindow) {
    console.log("messenger: opening simulated satellite window…");
    await new Promise((r) => setTimeout(r, 300));
    linkState = LinkState.SatelliteWindowOpen;
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const stats = await client.stats();
    console.log(
      `outbox=${stats.outbox.depth} budget_left=${stats.budget.remainingBytes}`,
    );
    if (stats.outbox.depth === 0) break;
    // Large may remain if budget cannot cover it — that is the demo point.
    if (
      stats.outbox.depth === 1 &&
      stats.budget.remainingBytes < large.byteLength
    ) {
      console.log(
        "messenger: text delivered; large payload deferred (budget) — ok",
      );
      await client.close();
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const final = await client.stats();
  console.log(
    `messenger: done outbox=${final.outbox.depth} budget_left=${final.budget.remainingBytes}`,
  );
  await client.close();
}

async function main(): Promise<void> {
  if (naive) {
    await runNaive();
    return;
  }
  await runNtnkit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
