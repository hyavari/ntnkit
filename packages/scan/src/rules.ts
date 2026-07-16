import { DEFAULT_TTL_MS, Priority, type Message } from "@ntnkit/core";

export type ScanSeverity = "info" | "warning" | "critical";

export interface ScanFinding {
  rule: string;
  severity: ScanSeverity;
  message: string;
}

export interface ScanConfig {
  maxPayloadBytes?: number;
  /** When true (default), Critical messages must set an explicit TTL below the default. */
  requireCriticalTtl?: boolean;
}

/** Default NTN-IoT guidance payload size used by scan and the CLI. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 1200;

const DEFAULT_CONFIG: Required<ScanConfig> = {
  maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES,
  requireCriticalTtl: true,
};

export function scanMessage(
  message: Message,
  config: ScanConfig = {},
): ScanFinding[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const findings: ScanFinding[] = [];

  if (message.payload.byteLength > cfg.maxPayloadBytes) {
    findings.push({
      rule: "payload-size",
      severity: "critical",
      message: `payload ${message.payload.byteLength}B exceeds NTN-IoT guidance ${cfg.maxPayloadBytes}B`,
    });
  }

  if (
    cfg.requireCriticalTtl &&
    message.priority === Priority.Critical &&
    message.ttlMs >= DEFAULT_TTL_MS
  ) {
    findings.push({
      rule: "critical-ttl",
      severity: "warning",
      message:
        "critical message uses default/long TTL — set an explicit shorter expiry",
    });
  }

  if (!message.dedupKey && message.priority >= Priority.High) {
    findings.push({
      rule: "idempotency",
      severity: "warning",
      message: "high/critical messages should set dedupKey for safe retries",
    });
  }

  return findings;
}

export function scanMessages(
  messages: Message[],
  config?: ScanConfig,
): ScanFinding[] {
  return messages.flatMap((m) => scanMessage(m, config));
}

export function hasCritical(findings: ScanFinding[]): boolean {
  return findings.some((f) => f.severity === "critical");
}
