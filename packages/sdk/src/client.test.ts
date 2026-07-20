import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  DeliveryMode,
  DeliveryStage,
  LinkState,
  Priority,
} from "@ntnkit/core";
import { connect, httpTransport, InMemoryOutbox } from "./index.js";

describe("connect", () => {
  it("delivers immediately when link is terrestrial", async () => {
    const calls: string[] = [];
    const client = await connect({
      transport: {
        name: "mock",
        getLinkState: async () => LinkState.Terrestrial,
        async send(message) {
          calls.push(new TextDecoder().decode(message.payload));
          return { delivered: true, latencyMs: 1 };
        },
      },
    });

    await client.send({
      payload: new TextEncoder().encode("ping"),
      delivery: DeliveryMode.Immediate,
    });

    expect(calls).toEqual(["ping"]);
    expect((await client.stats()).outbox.depth).toBe(0);
  });

  it("queues for next window when constrained", async () => {
    let link = LinkState.Constrained;
    const client = await connect({
      transport: {
        name: "mock",
        getLinkState: async () => link,
        async send() {
          return { delivered: true };
        },
      },
    });

    await client.send({
      payload: new TextEncoder().encode("queued"),
      delivery: DeliveryMode.NextWindow,
      priority: Priority.High,
    });

    expect((await client.stats()).outbox.depth).toBe(1);

    link = LinkState.SatelliteWindowOpen;
    const result = await client.flush();
    expect(result.sent).toBe(1);
    expect(result.deferred).toBe(0);
    expect((await client.stats()).outbox.depth).toBe(0);
  });

  it("skips deferred messages and continues flush", async () => {
    const sent: string[] = [];
    let link = LinkState.Constrained;
    const client = await connect({
      budget: { dailyBytes: 5 },
      transport: {
        name: "mock",
        getLinkState: async () => link,
        async send(message) {
          sent.push(new TextDecoder().decode(message.payload));
          return { delivered: true };
        },
      },
    });

    await client.send({
      payload: new TextEncoder().encode("too-big"),
      delivery: DeliveryMode.NextWindow,
      priority: Priority.Normal,
    });
    await client.send({
      payload: new TextEncoder().encode("ok"),
      delivery: DeliveryMode.NextWindow,
      priority: Priority.Low,
    });

    expect((await client.stats()).outbox.depth).toBe(2);

    link = LinkState.SatelliteWindowOpen;
    const result = await client.flush();
    expect(result.sent).toBe(1);
    expect(result.deferred).toBe(1);
    expect(result.failed).toBe(0);
    expect(sent).toEqual(["ok"]);
    expect((await client.stats()).outbox.depth).toBe(1);
  });

  it("delivers critical even when budget is exhausted", async () => {
    const sent: string[] = [];
    const client = await connect({
      budget: { dailyBytes: 3 },
      transport: {
        name: "mock",
        getLinkState: async () => LinkState.Terrestrial,
        async send(message) {
          sent.push(new TextDecoder().decode(message.payload));
          return { delivered: true };
        },
      },
    });

    await client.send({
      payload: new TextEncoder().encode("abc"),
      delivery: DeliveryMode.Immediate,
    });
    expect((await client.stats()).budget.remainingBytes).toBe(0);

    await client.send({
      payload: new TextEncoder().encode("sos"),
      delivery: DeliveryMode.Immediate,
      priority: Priority.Critical,
    });

    expect(sent).toEqual(["abc", "sos"]);
    expect((await client.stats()).outbox.depth).toBe(0);
  });

  it("counts airtime on failed send attempts by default", async () => {
    const client = await connect({
      budget: { dailyBytes: 10 },
      policy: { baseBackoffMs: 0, maxBackoffMs: 0 },
      transport: {
        name: "mock",
        getLinkState: async () => LinkState.Terrestrial,
        async send() {
          return { delivered: false, error: "down" };
        },
      },
    });

    await client.send({
      payload: new TextEncoder().encode("abcd"),
      delivery: DeliveryMode.Immediate,
    });

    expect((await client.stats()).budget.usedBytes).toBe(4);
    expect((await client.stats()).outbox.depth).toBe(1);
  });

  it("can disable charging failed attempts", async () => {
    const client = await connect({
      budget: { dailyBytes: 10, countFailedAttempts: false },
      policy: { baseBackoffMs: 0, maxBackoffMs: 0 },
      transport: {
        name: "mock",
        getLinkState: async () => LinkState.Terrestrial,
        async send() {
          return { delivered: false, error: "down" };
        },
      },
    });

    await client.send({
      payload: new TextEncoder().encode("abcd"),
      delivery: DeliveryMode.Immediate,
    });

    expect((await client.stats()).budget.usedBytes).toBe(0);
    expect((await client.stats()).budget.remainingBytes).toBe(10);
  });

  it("failed attempts can exhaust budget and block non-critical", async () => {
    const client = await connect({
      budget: { dailyBytes: 4 },
      policy: { baseBackoffMs: 0, maxBackoffMs: 0 },
      transport: {
        name: "mock",
        getLinkState: async () => LinkState.Terrestrial,
        async send() {
          return { delivered: false, error: "down" };
        },
      },
    });

    await client.send({
      payload: new TextEncoder().encode("abcd"),
      delivery: DeliveryMode.Immediate,
    });
    expect((await client.stats()).budget.remainingBytes).toBe(0);

    const before = (await client.stats()).outbox.depth;
    await client.send({
      payload: new TextEncoder().encode("xy"),
      delivery: DeliveryMode.Immediate,
      priority: Priority.Normal,
    });
    // Second message deferred (budget) and queued — no further send charged.
    expect((await client.stats()).outbox.depth).toBe(before + 1);
    expect((await client.stats()).budget.usedBytes).toBe(4);
  });

  it("evicts prior outbox entry when a deduped send succeeds", async () => {
    let link = LinkState.Constrained;
    const client = await connect({
      transport: {
        name: "mock",
        getLinkState: async () => link,
        async send() {
          return { delivered: true };
        },
      },
    });

    await client.send({
      payload: new TextEncoder().encode("old"),
      delivery: DeliveryMode.NextWindow,
      dedupKey: "same",
    });
    expect((await client.stats()).outbox.depth).toBe(1);

    link = LinkState.Terrestrial;
    await client.send({
      payload: new TextEncoder().encode("new"),
      delivery: DeliveryMode.Immediate,
      dedupKey: "same",
    });

    expect((await client.stats()).outbox.depth).toBe(0);
  });

  it("refreshes link state between flush messages", async () => {
    let link = LinkState.Constrained;
    const sent: string[] = [];
    const client = await connect({
      transport: {
        name: "mock",
        getLinkState: async () => link,
        async send(message) {
          sent.push(new TextDecoder().decode(message.payload));
          // Window closes after first successful send.
          link = LinkState.Constrained;
          return { delivered: true };
        },
      },
    });

    await client.send({
      payload: new TextEncoder().encode("a"),
      delivery: DeliveryMode.NextWindow,
      priority: Priority.High,
    });
    await client.send({
      payload: new TextEncoder().encode("b"),
      delivery: DeliveryMode.NextWindow,
      priority: Priority.Low,
    });
    expect((await client.stats()).outbox.depth).toBe(2);

    link = LinkState.SatelliteWindowOpen;
    const result = await client.flush();
    expect(sent).toEqual(["a"]);
    expect(result.sent).toBe(1);
    expect(result.deferred).toBe(1);
    expect((await client.stats()).outbox.depth).toBe(1);
  });

  it("serializes concurrent flush calls", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let link = LinkState.Constrained;
    const client = await connect({
      transport: {
        name: "mock",
        getLinkState: async () => link,
        async send() {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 20));
          inFlight -= 1;
          return { delivered: true };
        },
      },
    });

    await client.send({
      payload: new TextEncoder().encode("a"),
      delivery: DeliveryMode.NextWindow,
    });
    await client.send({
      payload: new TextEncoder().encode("b"),
      delivery: DeliveryMode.NextWindow,
    });

    link = LinkState.SatelliteWindowOpen;
    const [r1, r2] = await Promise.all([client.flush(), client.flush()]);
    expect(r1.sent + r2.sent).toBe(2);
    expect(maxInFlight).toBe(1);
    expect((await client.stats()).outbox.depth).toBe(0);
  });

  it("continues flush after failure so later messages still attempt", async () => {
    let calls = 0;
    let link = LinkState.Constrained;
    const client = await connect({
      policy: { maxAttemptsPerWindow: 2, baseBackoffMs: 0, maxBackoffMs: 0 },
      transport: {
        name: "mock",
        getLinkState: async () => link,
        async send() {
          calls += 1;
          return { delivered: false, error: "down" };
        },
      },
    });

    await client.send({
      payload: new TextEncoder().encode("a"),
      delivery: DeliveryMode.NextWindow,
      priority: Priority.High,
    });
    await client.send({
      payload: new TextEncoder().encode("b"),
      delivery: DeliveryMode.NextWindow,
      priority: Priority.Low,
    });

    link = LinkState.SatelliteWindowOpen;
    const first = await client.flush();
    expect(first.failed).toBe(2);
    expect(first.deferred).toBe(0);
    expect(first.sent).toBe(0);
    expect(calls).toBe(2);

    for (let i = 0; i < 5; i += 1) {
      await client.flush();
    }
    // Attempt caps + backoff limit further tries in-window.
    expect(calls).toBeLessThanOrEqual(4);
    expect((await client.stats()).outbox.depth).toBe(2);
  });

  it("resets attempt cap when a new satellite window opens", async () => {
    let calls = 0;
    let link = LinkState.Constrained;
    const client = await connect({
      policy: { maxAttemptsPerWindow: 1, baseBackoffMs: 0, maxBackoffMs: 0 },
      transport: {
        name: "mock",
        getLinkState: async () => link,
        async send() {
          calls += 1;
          return { delivered: false, error: "down" };
        },
      },
    });

    await client.send({
      payload: new TextEncoder().encode("a"),
      delivery: DeliveryMode.NextWindow,
    });
    expect(calls).toBe(0);

    link = LinkState.SatelliteWindowOpen;
    expect((await client.flush()).failed).toBe(1);
    expect(calls).toBe(1);

    expect((await client.flush()).deferred).toBe(1);
    expect(calls).toBe(1);

    link = LinkState.Constrained;
    await client.flush();
    expect(calls).toBe(1);
    link = LinkState.SatelliteWindowOpen;
    expect((await client.flush()).failed).toBe(1);
    expect(calls).toBe(2);
  });

  it("retries on terrestrial after backoff without permanent defer", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const client = await connect({
        policy: {
          maxAttemptsPerWindow: 1,
          baseBackoffMs: 1000,
          maxBackoffMs: 1000,
        },
        transport: {
          name: "mock",
          getLinkState: async () => LinkState.Terrestrial,
          async send() {
            calls += 1;
            return { delivered: false, error: "down" };
          },
        },
      });

      await client.send({
        payload: new TextEncoder().encode("a"),
        delivery: DeliveryMode.Immediate,
      });
      expect(calls).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);
      await client.flush();
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prunes expired outbox messages and clears attempt state", async () => {
    vi.useFakeTimers();
    try {
      const now = new Date("2026-01-01T00:00:00Z");
      vi.setSystemTime(now);

      let calls = 0;
      const client = await connect({
        policy: { baseBackoffMs: 0, maxBackoffMs: 0 },
        transport: {
          name: "mock",
          getLinkState: async () => LinkState.Terrestrial,
          async send() {
            calls += 1;
            return { delivered: false, error: "down" };
          },
        },
      });

      await client.send({
        payload: new TextEncoder().encode("temp"),
        delivery: DeliveryMode.Immediate,
        ttlMs: 1000,
        createdAt: now,
      });
      expect(calls).toBe(1);
      expect((await client.stats()).outbox.depth).toBe(1);

      vi.setSystemTime(new Date(now.getTime() + 2000));
      const result = await client.flush();
      expect(result.sent).toBe(0);
      expect((await client.stats()).outbox.depth).toBe(0);
      // Expired — no retry send.
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors WhenBudgetAllows through the client", async () => {
    const sent: string[] = [];
    const client = await connect({
      budget: { dailyBytes: 2 },
      transport: {
        name: "mock",
        getLinkState: async () => LinkState.Terrestrial,
        async send(message) {
          sent.push(new TextDecoder().decode(message.payload));
          return { delivered: true };
        },
      },
    });

    await client.send({
      payload: new TextEncoder().encode("ab"),
      delivery: DeliveryMode.WhenBudgetAllows,
    });
    expect(sent).toEqual(["ab"]);

    await client.send({
      payload: new TextEncoder().encode("x"),
      delivery: DeliveryMode.WhenBudgetAllows,
      priority: Priority.Critical,
    });
    expect(sent).toEqual(["ab"]);
    expect((await client.stats()).outbox.depth).toBe(1);
  });
});

describe("InMemoryOutbox", () => {
  it("enqueue list remove and stats track depth and age", async () => {
    const outbox = new InMemoryOutbox();
    const createdAt = new Date(Date.now() - 5_000);
    await outbox.enqueue({
      id: "1",
      payload: new TextEncoder().encode("a"),
      priority: Priority.Normal,
      ttlMs: 60_000,
      createdAt,
      delivery: DeliveryMode.Immediate,
    });
    expect(await outbox.list()).toHaveLength(1);
    expect(await outbox.remove("1")).toBe(true);
    expect(await outbox.has("1")).toBe(false);
    expect((await outbox.stats()).depth).toBe(0);
    expect((await outbox.stats()).oldestAgeMs).toBeNull();
  });

  it("pruneExpired returns and drops TTL-elapsed messages", async () => {
    const outbox = new InMemoryOutbox();
    await outbox.enqueue({
      id: "old",
      payload: new TextEncoder().encode("a"),
      priority: Priority.Normal,
      ttlMs: 10,
      createdAt: new Date(Date.now() - 1_000),
      delivery: DeliveryMode.Immediate,
    });
    await outbox.enqueue({
      id: "fresh",
      payload: new TextEncoder().encode("b"),
      priority: Priority.Normal,
      ttlMs: 60_000,
      createdAt: new Date(),
      delivery: DeliveryMode.Immediate,
    });
    const expired = await outbox.pruneExpired();
    expect(expired.map((m) => m.id)).toEqual(["old"]);
    expect(await outbox.has("old")).toBe(false);
    expect(await outbox.has("fresh")).toBe(true);
    expect((await outbox.stats()).oldestAgeMs).toBeGreaterThanOrEqual(0);
  });

  it("list orders by priority then age", async () => {
    const outbox = new InMemoryOutbox();
    const older = new Date(Date.now() - 2_000);
    const newer = new Date(Date.now() - 1_000);
    await outbox.enqueue({
      id: "low",
      payload: new TextEncoder().encode("a"),
      priority: Priority.Low,
      ttlMs: 60_000,
      createdAt: older,
      delivery: DeliveryMode.Immediate,
    });
    await outbox.enqueue({
      id: "high",
      payload: new TextEncoder().encode("b"),
      priority: Priority.High,
      createdAt: newer,
      ttlMs: 60_000,
      delivery: DeliveryMode.Immediate,
    });
    expect((await outbox.list()).map((m) => m.id)).toEqual(["high", "low"]);
  });

  it("removeByDedupKey drops the indexed message", async () => {
    const outbox = new InMemoryOutbox();
    await outbox.enqueue({
      id: "1",
      payload: new TextEncoder().encode("a"),
      priority: Priority.Normal,
      ttlMs: 60_000,
      createdAt: new Date(),
      delivery: DeliveryMode.Immediate,
      dedupKey: "k",
    });
    expect(await outbox.removeByDedupKey("k")).toBe("1");
    expect(await outbox.has("1")).toBe(false);
  });

  it("clears orphaned dedupIndex when message row is already gone", async () => {
    const outbox = new InMemoryOutbox();
    await outbox.enqueue({
      id: "1",
      payload: new TextEncoder().encode("a"),
      priority: Priority.Normal,
      ttlMs: 60_000,
      createdAt: new Date(),
      delivery: DeliveryMode.Immediate,
      dedupKey: "k",
    });
    // Corrupt: delete row without going through remove().
    (outbox as unknown as { messages: Map<string, unknown> }).messages.delete(
      "1",
    );
    expect(await outbox.removeByDedupKey("k")).toBe("1");
    // Re-enqueue with same key must work (index was cleared).
    await outbox.enqueue({
      id: "2",
      payload: new TextEncoder().encode("b"),
      priority: Priority.Normal,
      ttlMs: 60_000,
      createdAt: new Date(),
      delivery: DeliveryMode.Immediate,
      dedupKey: "k",
    });
    expect(await outbox.has("2")).toBe(true);
    expect(await outbox.removeByDedupKey("k")).toBe("2");
  });

  it("repairs dedupIndex when same id is overwritten with a new key", async () => {
    const outbox = new InMemoryOutbox();
    await outbox.enqueue({
      id: "1",
      payload: new TextEncoder().encode("a"),
      priority: Priority.Normal,
      ttlMs: 60_000,
      createdAt: new Date(),
      delivery: DeliveryMode.Immediate,
      dedupKey: "old",
    });
    await outbox.enqueue({
      id: "1",
      payload: new TextEncoder().encode("b"),
      priority: Priority.Normal,
      ttlMs: 60_000,
      createdAt: new Date(),
      delivery: DeliveryMode.Immediate,
      dedupKey: "new",
    });
    expect(await outbox.removeByDedupKey("old")).toBeUndefined();
    expect(await outbox.removeByDedupKey("new")).toBe("1");
  });
});

describe("connect ownership and status", () => {
  it("rejects outbox and store together", async () => {
    const outbox = new InMemoryOutbox();
    const store = {
      outbox,
      async loadAttempts() {
        return new Map();
      },
      async saveAttempt() {},
      async clearAttempt() {},
      async clearAllAttempts() {},
      async loadBudget() {
        return null;
      },
      async saveBudget() {},
      async close() {},
    };
    await expect(
      connect({
        outbox,
        store,
        transport: {
          name: "mock",
          getLinkState: async () => LinkState.Terrestrial,
          async send() {
            return { delivered: true };
          },
        },
      }),
    ).rejects.toThrow("mutually exclusive");
  });

  it("releases outbox claim if store hydrate fails", async () => {
    const outbox = new InMemoryOutbox();
    const transport = {
      name: "mock",
      getLinkState: async () => LinkState.Terrestrial,
      async send() {
        return { delivered: true };
      },
    };
    const store = {
      outbox,
      async loadAttempts() {
        return new Map();
      },
      async saveAttempt() {},
      async clearAttempt() {},
      async clearAllAttempts() {},
      async loadBudget() {
        throw new Error("hydrate failed");
      },
      async saveBudget() {},
      async close() {},
    };
    await expect(connect({ transport, store })).rejects.toThrow("hydrate failed");
    // Same outbox must be claimable again.
    const client = await connect({ transport, outbox });
    await client.close();
  });

  it("rejects sharing one Outbox across two clients", async () => {
    const outbox = new InMemoryOutbox();
    const transport = {
      name: "mock",
      getLinkState: async () => LinkState.Terrestrial,
      async send() {
        return { delivered: true };
      },
    };
    await connect({ transport, outbox });
    await expect(connect({ transport, outbox })).rejects.toThrow(
      "already owned",
    );
  });

  it("treats throwing transport as a failed attempt", async () => {
    const client = await connect({
      policy: { baseBackoffMs: 0, maxBackoffMs: 0 },
      transport: {
        name: "mock",
        getLinkState: async () => LinkState.Terrestrial,
        async send() {
          throw new Error("boom");
        },
      },
    });

    await client.send({
      payload: new TextEncoder().encode("x"),
      delivery: DeliveryMode.Immediate,
    });
    expect((await client.stats()).outbox.depth).toBe(1);
  });

  it("does not emit Transmitted when transport throws", async () => {
    const stages: DeliveryStage[] = [];
    const client = await connect({
      policy: { baseBackoffMs: 0, maxBackoffMs: 0 },
      transport: {
        name: "mock",
        getLinkState: async () => LinkState.Terrestrial,
        async send() {
          throw new Error("boom");
        },
      },
      onStatus: (e) => stages.push(e.stage),
    });

    await client.send({
      payload: new TextEncoder().encode("x"),
      delivery: DeliveryMode.Immediate,
    });

    expect(stages).toEqual([DeliveryStage.Accepted]);
    expect(stages).not.toContain(DeliveryStage.Transmitted);
  });

  it("emits Accepted only (no Transmitted) when deferred without send", async () => {
    const stages: DeliveryStage[] = [];
    const client = await connect({
      transport: {
        name: "mock",
        getLinkState: async () => LinkState.Constrained,
        async send() {
          return { delivered: true };
        },
      },
      onStatus: (e) => stages.push(e.stage),
    });

    await client.send({
      payload: new TextEncoder().encode("queued"),
      delivery: DeliveryMode.NextWindow,
    });

    expect(stages).toEqual([DeliveryStage.Accepted]);
    expect((await client.stats()).outbox.depth).toBe(1);
  });

  it("keeps delivering when onStatus throws", async () => {
    const client = await connect({
      transport: {
        name: "mock",
        getLinkState: async () => LinkState.Terrestrial,
        async send() {
          return { delivered: true };
        },
      },
      onStatus: () => {
        throw new Error("hook failed");
      },
    });

    await expect(
      client.send({
        payload: new TextEncoder().encode("ok"),
        delivery: DeliveryMode.Immediate,
      }),
    ).resolves.toBeTruthy();
    expect((await client.stats()).outbox.depth).toBe(0);
  });

  it("swallows rejected promises from async onStatus", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const client = await connect({
        transport: {
          name: "mock",
          getLinkState: async () => LinkState.Terrestrial,
          async send() {
            return { delivered: true };
          },
        },
        onStatus: async () => {
          throw new Error("async hook failed");
        },
      });

      await expect(
        client.send({
          payload: new TextEncoder().encode("ok"),
          delivery: DeliveryMode.Immediate,
        }),
      ).resolves.toBeTruthy();
      await new Promise((r) => setTimeout(r, 25));
      expect(rejections).toEqual([]);
      expect((await client.stats()).outbox.depth).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("emits expired when TTL elapses before flush", async () => {
    const stages: DeliveryStage[] = [];
    let link = LinkState.Constrained;
    const client = await connect({
      transport: {
        name: "mock",
        getLinkState: async () => link,
        async send() {
          return { delivered: true };
        },
      },
      onStatus: (e) => {
        stages.push(e.stage);
      },
    });

    await client.send({
      payload: new TextEncoder().encode("stale"),
      delivery: DeliveryMode.NextWindow,
      ttlMs: 1,
      createdAt: new Date(Date.now() - 1000),
    });
    expect((await client.stats()).outbox.depth).toBe(1);

    link = LinkState.SatelliteWindowOpen;
    const result = await client.flush();
    expect(result.sent).toBe(0);
    expect(stages).toContain(DeliveryStage.Expired);
    expect((await client.stats()).outbox.depth).toBe(0);
  });

  it("allows onStatus to call flush without deadlocking", async () => {
    let link = LinkState.Constrained;
    let resolveFlushed!: () => void;
    const flushed = new Promise<void>((resolve) => {
      resolveFlushed = resolve;
    });
    const client = await connect({
      transport: {
        name: "mock",
        getLinkState: async () => link,
        async send() {
          return { delivered: true };
        },
      },
      onStatus: (e) => {
        if (e.stage === DeliveryStage.Accepted) {
          link = LinkState.SatelliteWindowOpen;
          void client.flush().then(resolveFlushed);
        }
      },
    });

    await client.send({
      payload: new TextEncoder().encode("queued"),
      delivery: DeliveryMode.NextWindow,
    });
    await flushed;

    expect((await client.stats()).outbox.depth).toBe(0);
  });

  it("keeps Accepted message queued if getLinkState throws after persist", async () => {
    const stages: DeliveryStage[] = [];
    let blowUp = true;
    const client = await connect({
      transport: {
        name: "mock",
        getLinkState: async () => {
          if (blowUp) {
            blowUp = false;
            throw new Error("link probe failed");
          }
          return LinkState.Terrestrial;
        },
        async send() {
          return { delivered: true };
        },
      },
      onStatus: (e) => stages.push(e.stage),
    });

    await expect(
      client.send({
        payload: new TextEncoder().encode("x"),
        delivery: DeliveryMode.Immediate,
      }),
    ).rejects.toThrow("link probe failed");

    // Accepted was queued for flush after lock release; message stayed in outbox.
    expect((await client.stats()).outbox.depth).toBe(1);
    expect(stages).toEqual([DeliveryStage.Accepted]);

    await client.flush();
    expect((await client.stats()).outbox.depth).toBe(0);
  });

  it("emits Accepted → Transmitted → Delivered on Immediate success (store-then-send)", async () => {
    const stages: DeliveryStage[] = [];
    let depthDuringSend = -1;
    const client = await connect({
      transport: {
        name: "mock",
        getLinkState: async () => LinkState.Terrestrial,
        async send() {
          // Pre-queued under the lock before transport runs.
          depthDuringSend = (await client.stats()).outbox.depth;
          return { delivered: true };
        },
      },
      onStatus: (e) => stages.push(e.stage),
    });

    await client.send({
      payload: new TextEncoder().encode("ok"),
      delivery: DeliveryMode.Immediate,
    });

    expect(depthDuringSend).toBe(1);
    expect((await client.stats()).outbox.depth).toBe(0);
    expect(stages).toEqual([
      DeliveryStage.Accepted,
      DeliveryStage.Transmitted,
      DeliveryStage.Delivered,
    ]);
  });

  it("allows onStatus to call send without deadlocking", async () => {
    const sent: string[] = [];
    let resolveSecond!: () => void;
    const secondDone = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    let firstAccepted = true;
    const client = await connect({
      transport: {
        name: "mock",
        getLinkState: async () => LinkState.Terrestrial,
        async send(message) {
          sent.push(new TextDecoder().decode(message.payload));
          return { delivered: true };
        },
      },
      onStatus: (e) => {
        if (e.stage === DeliveryStage.Accepted && firstAccepted) {
          firstAccepted = false;
          void client
            .send({
              payload: new TextEncoder().encode("second"),
              delivery: DeliveryMode.Immediate,
            })
            .then(resolveSecond);
        }
      },
    });

    await client.send({
      payload: new TextEncoder().encode("first"),
      delivery: DeliveryMode.Immediate,
    });
    await secondDone;

    expect(sent).toEqual(["first", "second"]);
    expect((await client.stats()).outbox.depth).toBe(0);
  });

  it("delivers one lock-batch in order before nested fire-and-forget status", async () => {
    const stages: Array<{ id: string; stage: DeliveryStage }> = [];
    let nestedSendStarted = false;
    const client = await connect({
      transport: {
        name: "mock",
        getLinkState: async () => LinkState.Terrestrial,
        async send() {
          return { delivered: true };
        },
      },
      onStatus: (e) => {
        stages.push({ id: e.id, stage: e.stage });
        if (e.stage === DeliveryStage.Accepted && !nestedSendStarted) {
          nestedSendStarted = true;
          // Fire-and-forget: must not reorder the outer message's remaining stages.
          void client.send({
            payload: new TextEncoder().encode("nested"),
            delivery: DeliveryMode.Immediate,
          });
        }
      },
    });

    const firstId = await client.send({
      payload: new TextEncoder().encode("outer"),
      delivery: DeliveryMode.Immediate,
    });

    // Wait until nested send has produced at least Accepted.
    await vi.waitFor(() => {
      expect(
        stages.some(
          (s) => s.id !== firstId && s.stage === DeliveryStage.Accepted,
        ),
      ).toBe(true);
    });

    const outerStages = stages
      .filter((s) => s.id === firstId)
      .map((s) => s.stage);
    expect(outerStages).toEqual([
      DeliveryStage.Accepted,
      DeliveryStage.Transmitted,
      DeliveryStage.Delivered,
    ]);
    // Outer batch is contiguous at the start (nested events come after).
    expect(stages.slice(0, 3).map((s) => s.id)).toEqual([
      firstId,
      firstId,
      firstId,
    ]);
  });

  it("close() releases outbox ownership for reuse", async () => {
    const outbox = new InMemoryOutbox();
    const transport = {
      name: "mock",
      getLinkState: async () => LinkState.Terrestrial,
      async send() {
        return { delivered: true };
      },
    };
    const first = await connect({ transport, outbox });
    await first.close();
    const second = await connect({ transport, outbox });
    await expect(
      second.send({
        payload: new TextEncoder().encode("x"),
        delivery: DeliveryMode.Immediate,
      }),
    ).resolves.toBeTruthy();
    await expect(first.send({
      payload: new TextEncoder().encode("y"),
      delivery: DeliveryMode.Immediate,
    })).rejects.toThrow("closed");
    await second.close();
  });

  it("serializes concurrent send and flush", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let link = LinkState.Constrained;
    const client = await connect({
      transport: {
        name: "mock",
        getLinkState: async () => link,
        async send() {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 15));
          inFlight -= 1;
          return { delivered: true };
        },
      },
    });

    await client.send({
      payload: new TextEncoder().encode("queued"),
      delivery: DeliveryMode.NextWindow,
    });

    link = LinkState.SatelliteWindowOpen;
    await Promise.all([
      client.flush(),
      client.send({
        payload: new TextEncoder().encode("extra"),
        delivery: DeliveryMode.Immediate,
      }),
    ]);

    expect(maxInFlight).toBe(1);
    expect((await client.stats()).outbox.depth).toBe(0);
  });
});

describe("autoFlush", () => {
  async function waitFor(
    predicate: () => Promise<boolean>,
    timeoutMs = 2000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("waitFor timed out");
  }

  it("drains on window open without manual flush", async () => {
    let link = LinkState.Constrained;
    let sends = 0;
    const client = await connect({
      autoFlush: { intervalMs: 40 },
      transport: {
        name: "mock",
        getLinkState: async () => link,
        async send() {
          sends += 1;
          return { delivered: true };
        },
      },
    });

    await client.send({
      payload: new TextEncoder().encode("x"),
      delivery: DeliveryMode.NextWindow,
      dedupKey: "auto-1",
    });
    expect((await client.stats()).outbox.depth).toBe(1);
    expect(sends).toBe(0);

    link = LinkState.SatelliteWindowOpen;
    await waitFor(async () => (await client.stats()).outbox.depth === 0);
    expect(sends).toBe(1);
    await client.close();
  });

  it("does not start a worker when autoFlush is unset", async () => {
    let polls = 0;
    const client = await connect({
      transport: {
        name: "mock",
        getLinkState: async () => {
          polls += 1;
          return LinkState.Constrained;
        },
        async send() {
          return { delivered: true };
        },
      },
    });
    await client.send({
      payload: new TextEncoder().encode("x"),
      delivery: DeliveryMode.NextWindow,
    });
    await new Promise((r) => setTimeout(r, 80));
    // send() polls once; no background polls afterward.
    expect(polls).toBe(1);
    await client.close();
  });
});

describe("httpTransport", () => {
  it("reports fetch failures", async () => {
    const transport = httpTransport({
      url: "http://127.0.0.1:1/no-such-host",
      timeoutMs: 500,
    });
    const result = await transport.send({
      id: "1",
      payload: new TextEncoder().encode("x"),
      priority: Priority.Normal,
      ttlMs: 60_000,
      createdAt: new Date(),
      delivery: DeliveryMode.Immediate,
    });
    expect(result.delivered).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("times out hung requests", async () => {
    const server = createServer((req, res) => {
      // Never respond — client should abort.
      req.resume();
      void res;
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("bind failed");
    }

    try {
      const transport = httpTransport({
        url: `http://127.0.0.1:${addr.port}/`,
        timeoutMs: 50,
      });
      const result = await transport.send({
        id: "1",
        payload: new TextEncoder().encode("x"),
        priority: Priority.Normal,
        ttlMs: 60_000,
        createdAt: new Date(),
        delivery: DeliveryMode.Immediate,
      });
      expect(result.delivered).toBe(false);
      expect(result.error).toMatch(/abort|timeout/i);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("does not let user headers override reserved ntnkit headers", async () => {
    let sawId: string | null = null;
    let sawIdem: string | null = null;
    const server = createServer((req, res) => {
      const idHeader = req.headers["x-ntnkit-message-id"];
      const idemHeader = req.headers["idempotency-key"];
      sawId = Array.isArray(idHeader) ? (idHeader[0] ?? null) : (idHeader ?? null);
      sawIdem = Array.isArray(idemHeader)
        ? (idemHeader[0] ?? null)
        : (idemHeader ?? null);
      req.resume();
      req.on("end", () => {
        res.writeHead(200);
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("bind failed");

    try {
      const transport = httpTransport({
        url: `http://127.0.0.1:${addr.port}/`,
        headers: {
          "x-ntnkit-message-id": "forged",
          "idempotency-key": "forged-key",
        },
      });
      await transport.send({
        id: "real-id",
        payload: new TextEncoder().encode("x"),
        priority: Priority.Normal,
        ttlMs: 60_000,
        createdAt: new Date(),
        delivery: DeliveryMode.Immediate,
        dedupKey: "real-key",
      });
      expect(sawId).toBe("real-id");
      expect(sawIdem).toBe("real-key");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("sends metadata as x-ntnkit-metadata JSON", async () => {
    let metaHeader: string | string[] | undefined;
    const server = createServer((req, res) => {
      metaHeader = req.headers["x-ntnkit-metadata"];
      req.resume();
      req.on("end", () => {
        res.writeHead(200);
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("bind failed");

    try {
      const transport = httpTransport({
        url: `http://127.0.0.1:${addr.port}/`,
      });
      await transport.send({
        id: "1",
        payload: new TextEncoder().encode("x"),
        priority: Priority.Normal,
        ttlMs: 60_000,
        createdAt: new Date(),
        delivery: DeliveryMode.Immediate,
        metadata: { region: "leo", kind: "telemetry" },
      });
      expect(metaHeader).toBe(
        JSON.stringify({ region: "leo", kind: "telemetry" }),
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("sends a single content-type when user and message both set it", async () => {
    let contentType: string | string[] | undefined;
    const server = createServer((req, res) => {
      contentType = req.headers["content-type"];
      req.resume();
      req.on("end", () => {
        res.writeHead(200);
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("bind failed");

    try {
      const transport = httpTransport({
        url: `http://127.0.0.1:${addr.port}/`,
        headers: { "Content-Type": "text/plain" },
      });
      await transport.send({
        id: "1",
        payload: new TextEncoder().encode("x"),
        priority: Priority.Normal,
        ttlMs: 60_000,
        createdAt: new Date(),
        delivery: DeliveryMode.Immediate,
        contentType: "application/json",
      });
      expect(contentType).toBe("application/json");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
