import { describe, expect, it } from "vitest";
import {
  ByteBudget,
  DeliveryMode,
  LinkState,
  Priority,
  createMessage,
  payloadByteLength,
  satelliteBackoffMs,
  shouldSend,
  sortForFlush,
} from "./index.js";

describe("createMessage", () => {
  it("assigns defaults", () => {
    const msg = createMessage({
      payload: new TextEncoder().encode("hello"),
    });
    expect(msg.priority).toBe(Priority.Normal);
    expect(msg.delivery).toBe(DeliveryMode.NextWindow);
    expect(msg.id).toBeTruthy();
  });

  it("rejects empty payload", () => {
    expect(() => createMessage({ payload: new Uint8Array() })).toThrow(
      "payload must not be empty",
    );
  });

  it("rejects invalid ttl, id, and dedupKey", () => {
    const payload = new TextEncoder().encode("x");
    expect(() => createMessage({ payload, ttlMs: 0 })).toThrow("ttlMs");
    expect(() => createMessage({ payload, id: "" })).toThrow("id");
    expect(() => createMessage({ payload, dedupKey: "" })).toThrow("dedupKey");
  });

  it("rejects header-unsafe id and dedupKey", () => {
    const payload = new TextEncoder().encode("x");
    expect(() => createMessage({ payload, id: "bad\nid" })).toThrow(
      "header-safe",
    );
    expect(() => createMessage({ payload, dedupKey: "has space" })).toThrow(
      "header-safe",
    );
  });

  it("rejects out-of-range createdAt and invalid Date", () => {
    const payload = new TextEncoder().encode("x");
    expect(() =>
      createMessage({
        payload,
        createdAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      }),
    ).toThrow("1 hour");
    expect(() =>
      createMessage({
        payload,
        createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      }),
    ).toThrow("7 days");
    expect(() =>
      createMessage({ payload, createdAt: new Date("not-a-date") }),
    ).toThrow("valid Date");
  });

  it("rejects CR/LF in contentType", () => {
    const payload = new TextEncoder().encode("x");
    expect(() =>
      createMessage({ payload, contentType: "text/plain\r\nX-Injected: 1" }),
    ).toThrow("contentType");
  });

  it("rejects unsafe metadata keys or values", () => {
    const payload = new TextEncoder().encode("x");
    expect(() =>
      createMessage({ payload, metadata: { "bad key": "v" } }),
    ).toThrow("metadata key");
    expect(() =>
      createMessage({ payload, metadata: { ok: "bad\nvalue" } }),
    ).toThrow("metadata value");
  });

  it("enforces maxBytes", () => {
    const payload = new TextEncoder().encode("hello");
    expect(() => createMessage({ payload, maxBytes: 0 })).toThrow("maxBytes");
    expect(() => createMessage({ payload, maxBytes: 3 })).toThrow("exceeds");
    expect(createMessage({ payload, maxBytes: 5 }).maxBytes).toBe(5);
  });

  it("payloadByteLength matches payload", () => {
    const msg = createMessage({
      payload: new TextEncoder().encode("abc"),
    });
    expect(payloadByteLength(msg)).toBe(3);
  });
});

describe("ByteBudget", () => {
  it("tracks daily spend", () => {
    const budget = new ByteBudget({ dailyBytes: 100 });
    budget.spend(40);
    expect(budget.remaining()).toBe(60);
    budget.spend(60);
    expect(budget.canSpend(1)).toBe(false);
  });

  it("rolls over on UTC day change", () => {
    const budget = new ByteBudget({ dailyBytes: 100 });
    budget.spend(80, new Date("2026-01-01T12:00:00Z"));
    expect(budget.remaining(new Date("2026-01-02T00:00:00Z"))).toBe(100);
  });

  it("caps usedBytes in snapshot and reports overspentBytes", () => {
    const budget = new ByteBudget({ dailyBytes: 10 });
    budget.spend(15, new Date(), true);
    const snap = budget.snapshot();
    expect(snap.usedBytes).toBe(10);
    expect(snap.remainingBytes).toBe(0);
    expect(snap.overspentBytes).toBe(5);
  });
});

describe("shouldSend", () => {
  const msg = createMessage({
    payload: new TextEncoder().encode("x"),
    delivery: DeliveryMode.NextWindow,
  });

  it("waits for satellite window", () => {
    expect(
      shouldSend(msg, {
        linkState: LinkState.Constrained,
        budgetRemainingBytes: 100,
      }),
    ).toBe(false);

    expect(
      shouldSend(msg, {
        linkState: LinkState.SatelliteWindowOpen,
        budgetRemainingBytes: 100,
      }),
    ).toBe(true);
  });

  it("blocks non-critical when budget is exhausted", () => {
    const normal = createMessage({
      payload: new TextEncoder().encode("x"),
      delivery: DeliveryMode.Immediate,
      priority: Priority.Normal,
    });
    expect(
      shouldSend(normal, {
        linkState: LinkState.Terrestrial,
        budgetRemainingBytes: 0,
      }),
    ).toBe(false);
  });

  it("allows critical Immediate overspend but not High", () => {
    const high = createMessage({
      payload: new TextEncoder().encode("hi"),
      delivery: DeliveryMode.Immediate,
      priority: Priority.High,
    });
    const sos = createMessage({
      payload: new TextEncoder().encode("sos"),
      delivery: DeliveryMode.Immediate,
      priority: Priority.Critical,
    });
    const ctx = {
      linkState: LinkState.Terrestrial,
      budgetRemainingBytes: 0,
    };
    expect(shouldSend(high, ctx)).toBe(false);
    expect(shouldSend(sos, ctx)).toBe(true);
  });

  it("WhenBudgetAllows is strict even for critical", () => {
    const sos = createMessage({
      payload: new TextEncoder().encode("sos"),
      delivery: DeliveryMode.WhenBudgetAllows,
      priority: Priority.Critical,
    });
    expect(
      shouldSend(sos, {
        linkState: LinkState.Terrestrial,
        budgetRemainingBytes: 0,
      }),
    ).toBe(false);
    expect(
      shouldSend(sos, {
        linkState: LinkState.Terrestrial,
        budgetRemainingBytes: 3,
      }),
    ).toBe(true);
  });
});

describe("satelliteBackoffMs", () => {
  it("applies full jitter within [1, ceiling]", () => {
    const delay = satelliteBackoffMs(2, { baseBackoffMs: 1000 }, () => 0.5);
    // ceiling = 4000 → 1 + floor(0.5 * 4000) = 2001
    expect(delay).toBe(2001);
  });

  it("never returns 0 when ceiling is positive", () => {
    expect(satelliteBackoffMs(0, { baseBackoffMs: 1000 }, () => 0)).toBe(1);
  });

  it("respects maxBackoffMs", () => {
    const delay = satelliteBackoffMs(
      10,
      { baseBackoffMs: 1000, maxBackoffMs: 5000 },
      () => 0.999999,
    );
    expect(delay).toBe(5000);
  });
});

describe("sortForFlush", () => {
  it("orders by priority then age", () => {
    const low = createMessage({
      payload: new TextEncoder().encode("a"),
      priority: Priority.Low,
      createdAt: new Date(Date.now() - 2_000),
    });
    const high = createMessage({
      payload: new TextEncoder().encode("b"),
      priority: Priority.High,
      createdAt: new Date(Date.now() - 1_000),
    });
    const sorted = sortForFlush([low, high]);
    expect(sorted[0].id).toBe(high.id);
  });
});
