import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeliveryMode,
  DeliveryStage,
  LinkState,
  Priority,
  createMessage,
} from "@ntnkit/core";
import { connect, type Transport } from "@ntnkit/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteStore } from "./index.js";

const encoder = new TextEncoder();

function terrestrialOk(): Transport {
  return {
    name: "mock",
    async getLinkState() {
      return LinkState.Terrestrial;
    },
    async send() {
      return { delivered: true };
    },
  };
}

describe("SqliteOutbox", () => {
  const paths: string[] = [];

  afterEach(async () => {
    while (paths.length > 0) {
      const p = paths.pop();
      if (p) await rm(p, { recursive: true, force: true });
    }
  });

  async function tempDb(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ntnkit-sqlite-"));
    paths.push(dir);
    return join(dir, "outbox.db");
  }

  it("survives restart with queued Critical", async () => {
    const path = await tempDb();
    const store1 = await openSqliteStore({ path });
    const msg = createMessage({
      payload: encoder.encode("critical"),
      priority: Priority.Critical,
      delivery: DeliveryMode.NextWindow,
      dedupKey: "c1",
    });
    await store1.outbox.enqueue(msg);
    await store1.close();

    const store2 = await openSqliteStore({ path });
    const listed = await store2.outbox.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(msg.id);
    expect(listed[0]?.priority).toBe(Priority.Critical);
    await store2.close();
  });

  it("replaces by dedupKey across restart", async () => {
    const path = await tempDb();
    const store1 = await openSqliteStore({ path });
    await store1.outbox.enqueue(
      createMessage({
        id: "a",
        payload: encoder.encode("1"),
        delivery: DeliveryMode.NextWindow,
        dedupKey: "k",
      }),
    );
    await store1.outbox.enqueue(
      createMessage({
        id: "b",
        payload: encoder.encode("2"),
        delivery: DeliveryMode.NextWindow,
        dedupKey: "k",
      }),
    );
    await store1.close();

    const store2 = await openSqliteStore({ path });
    const listed = await store2.outbox.list();
    expect(listed.map((m) => m.id)).toEqual(["b"]);
    await store2.close();
  });

  it("prunes expired after restart", async () => {
    const path = await tempDb();
    const store1 = await openSqliteStore({ path });
    await store1.outbox.enqueue(
      createMessage({
        id: "old",
        payload: encoder.encode("x"),
        ttlMs: 1,
        createdAt: new Date(Date.now() - 10_000),
        delivery: DeliveryMode.NextWindow,
      }),
    );
    await store1.close();

    const store2 = await openSqliteStore({ path });
    const expired = await store2.outbox.pruneExpired();
    expect(expired.map((m) => m.id)).toEqual(["old"]);
    expect(await store2.outbox.has("old")).toBe(false);
    await store2.close();
  });

  it("persists budget and attempts", async () => {
    const path = await tempDb();
    const store1 = await openSqliteStore({ path });
    await store1.saveBudget({ dayKey: "2026-07-20", usedBytes: 42 });
    await store1.saveAttempt("m1", { attempts: 2, nextAllowedAt: 99 });
    await store1.close();

    const store2 = await openSqliteStore({ path });
    expect(await store2.loadBudget()).toEqual({
      dayKey: "2026-07-20",
      usedBytes: 42,
    });
    expect([...(await store2.loadAttempts()).entries()]).toEqual([
      ["m1", { attempts: 2, nextAllowedAt: 99 }],
    ]);
    await store2.close();
  });

  it("resends after simulated crash between ack and remove", async () => {
    const path = await tempDb();
    const store1 = await openSqliteStore({ path });
    // First process: transport delivers, but remove paths are skipped (crash).
    const realRemove = store1.outbox.remove.bind(store1.outbox);
    const realRemoveByDedup = store1.outbox.removeByDedupKey.bind(store1.outbox);
    store1.outbox.remove = async () => true;
    store1.outbox.removeByDedupKey = async () => undefined;

    const seen = new Set<string>();
    let sends = 0;
    let duplicateSideEffects = 0;
    const client1 = await connect({
      store: store1,
      transport: {
        name: "mock",
        async getLinkState() {
          return LinkState.Terrestrial;
        },
        async send(message) {
          sends += 1;
          const key = message.dedupKey ?? message.id;
          if (seen.has(key)) {
            duplicateSideEffects += 1;
            return { delivered: true };
          }
          seen.add(key);
          return { delivered: true };
        },
      },
    });
    await client1.send({
      payload: encoder.encode("once"),
      priority: Priority.Critical,
      delivery: DeliveryMode.Immediate,
      dedupKey: "idem-1",
    });
    expect(sends).toBe(1);
    expect(duplicateSideEffects).toBe(0);
    store1.outbox.remove = realRemove;
    store1.outbox.removeByDedupKey = realRemoveByDedup;
    expect((await store1.outbox.list()).map((m) => m.dedupKey)).toEqual([
      "idem-1",
    ]);
    await client1.close();

    sends = 0;
    const store2 = await openSqliteStore({ path });
    const client2 = await connect({
      store: store2,
      transport: {
        name: "mock",
        async getLinkState() {
          return LinkState.Terrestrial;
        },
        async send(message) {
          sends += 1;
          const key = message.dedupKey ?? message.id;
          if (seen.has(key)) {
            duplicateSideEffects += 1;
            return { delivered: true };
          }
          seen.add(key);
          return { delivered: true };
        },
      },
    });

    expect((await client2.stats()).outbox.depth).toBe(1);
    expect((await client2.flush()).sent).toBe(1);
    expect(sends).toBe(1);
    expect(duplicateSideEffects).toBe(1); // server already saw first send
    expect((await client2.stats()).outbox.depth).toBe(0);
    await client2.close();
  });

  it("delivers Critical once after kill/restart via connect", async () => {
    const path = await tempDb();
    const store1 = await openSqliteStore({ path });
    let link = LinkState.Constrained;
    const client1 = await connect({
      store: store1,
      transport: {
        name: "mock",
        async getLinkState() {
          return link;
        },
        async send() {
          return { delivered: true };
        },
      },
    });

    await client1.send({
      payload: encoder.encode("c"),
      priority: Priority.Critical,
      delivery: DeliveryMode.NextWindow,
      dedupKey: "crit",
    });
    expect((await client1.stats()).outbox.depth).toBe(1);
    // Close without delivering (process kill simulation).
    await client1.close();

    link = LinkState.SatelliteWindowOpen;
    const store2 = await openSqliteStore({ path });
    let sends = 0;
    const stages: DeliveryStage[] = [];
    const client2 = await connect({
      store: store2,
      onStatus: (e) => stages.push(e.stage),
      transport: {
        name: "mock",
        async getLinkState() {
          return link;
        },
        async send() {
          sends += 1;
          return { delivered: true };
        },
      },
    });

    expect((await client2.stats()).outbox.depth).toBe(1);
    const result = await client2.flush();
    expect(result.sent).toBe(1);
    expect(sends).toBe(1);
    expect((await client2.stats()).outbox.depth).toBe(0);
    expect(stages).toContain(DeliveryStage.Delivered);
    await client2.close();
  });

  it("preserves budget across reconnect", async () => {
    const path = await tempDb();
    const store1 = await openSqliteStore({ path });
    const client1 = await connect({
      store: store1,
      budget: { dailyBytes: 100, countFailedAttempts: false },
      transport: terrestrialOk(),
    });
    await client1.send({
      payload: encoder.encode("abcd"), // 4 bytes
      delivery: DeliveryMode.Immediate,
    });
    expect((await client1.stats()).budget.usedBytes).toBe(4);
    await client1.close();

    const store2 = await openSqliteStore({ path });
    const client2 = await connect({
      store: store2,
      budget: { dailyBytes: 100, countFailedAttempts: false },
      transport: terrestrialOk(),
    });
    expect((await client2.stats()).budget.usedBytes).toBe(4);
    expect((await client2.stats()).budget.remainingBytes).toBe(96);
    await client2.close();
  });

  it("preserves attempt budget across restart while window stays open", async () => {
    const path = await tempDb();
    const store1 = await openSqliteStore({ path });
    let sends = 0;
    const client1 = await connect({
      store: store1,
      policy: { maxAttemptsPerWindow: 1, baseBackoffMs: 0, maxBackoffMs: 0 },
      transport: {
        name: "mock",
        async getLinkState() {
          return LinkState.SatelliteWindowOpen;
        },
        async send() {
          sends += 1;
          return { delivered: false, error: "nope" };
        },
      },
    });
    await client1.send({
      payload: encoder.encode("x"),
      delivery: DeliveryMode.NextWindow,
      dedupKey: "a",
    });
    expect(sends).toBe(1);
    expect((await client1.flush()).deferred).toBe(1); // capped
    await client1.close();

    sends = 0;
    const store2 = await openSqliteStore({ path });
    const client2 = await connect({
      store: store2,
      policy: { maxAttemptsPerWindow: 1, baseBackoffMs: 0, maxBackoffMs: 0 },
      transport: {
        name: "mock",
        async getLinkState() {
          return LinkState.SatelliteWindowOpen;
        },
        async send() {
          sends += 1;
          return { delivered: false, error: "nope" };
        },
      },
    });
    // Must not reset attempts just because lastLinkState was null after restart.
    expect((await client2.flush()).deferred).toBe(1);
    expect(sends).toBe(0);
    await client2.close();
  });

  it("keeps message after interrupted send across restart", async () => {
    const path = await tempDb();
    const store1 = await openSqliteStore({ path });
    let fail = true;
    const client1 = await connect({
      store: store1,
      policy: { baseBackoffMs: 0, maxBackoffMs: 0 },
      transport: {
        name: "mock",
        async getLinkState() {
          return LinkState.Terrestrial;
        },
        async send() {
          if (fail) throw new Error("boom");
          return { delivered: true };
        },
      },
    });
    await client1.send({
      payload: encoder.encode("x"),
      delivery: DeliveryMode.Immediate,
      dedupKey: "x",
    });
    expect((await client1.stats()).outbox.depth).toBe(1);
    await client1.close();

    fail = false;
    const store2 = await openSqliteStore({ path });
    const client2 = await connect({
      store: store2,
      policy: { baseBackoffMs: 0, maxBackoffMs: 0 },
      transport: {
        name: "mock",
        async getLinkState() {
          return LinkState.Terrestrial;
        },
        async send() {
          return { delivered: true };
        },
      },
    });
    expect((await client2.stats()).outbox.depth).toBe(1);
    expect((await client2.flush()).sent).toBe(1);
    await client2.close();
  });
});
