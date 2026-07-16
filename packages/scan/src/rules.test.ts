import { describe, expect, it } from "vitest";
import { DEFAULT_TTL_MS, Priority, createMessage } from "@ntnkit/core";
import { scanMessage, hasCritical, DEFAULT_MAX_PAYLOAD_BYTES } from "./rules.js";

describe("scanMessage", () => {
  it("flags oversized payloads", () => {
    const msg = createMessage({
      payload: new Uint8Array(2000),
    });
    const findings = scanMessage(msg, {
      maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES,
    });
    expect(hasCritical(findings)).toBe(true);
  });

  it("warns on high priority without dedup key", () => {
    const msg = createMessage({
      payload: new TextEncoder().encode("sos"),
      priority: Priority.Critical,
      ttlMs: 60_000,
    });
    const findings = scanMessage(msg);
    expect(findings.some((f) => f.rule === "idempotency")).toBe(true);
  });

  it("warns when critical uses default/long TTL", () => {
    const msg = createMessage({
      payload: new TextEncoder().encode("sos"),
      priority: Priority.Critical,
      dedupKey: "sos-1",
    });
    expect(msg.ttlMs).toBe(DEFAULT_TTL_MS);
    const findings = scanMessage(msg);
    expect(findings.some((f) => f.rule === "critical-ttl")).toBe(true);
  });

  it("does not warn critical-ttl when critical sets a short TTL", () => {
    const msg = createMessage({
      payload: new TextEncoder().encode("sos"),
      priority: Priority.Critical,
      dedupKey: "sos-1",
      ttlMs: 60_000,
    });
    const findings = scanMessage(msg);
    expect(findings.some((f) => f.rule === "critical-ttl")).toBe(false);
  });

  it("skips critical-ttl when requireCriticalTtl is false", () => {
    const msg = createMessage({
      payload: new TextEncoder().encode("sos"),
      priority: Priority.Critical,
      dedupKey: "sos-1",
    });
    const findings = scanMessage(msg, { requireCriticalTtl: false });
    expect(findings.some((f) => f.rule === "critical-ttl")).toBe(false);
  });
});
