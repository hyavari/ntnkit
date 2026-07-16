/** Link quality abstraction — transport-specific sources map into this. */
export enum LinkState {
  Offline = "offline",
  Terrestrial = "terrestrial",
  Constrained = "constrained",
  SatelliteWindowOpen = "satellite_window_open",
}

export enum Priority {
  Low = 0,
  Normal = 1,
  High = 2,
  Critical = 3,
}

export enum DeliveryMode {
  Immediate = "immediate",
  NextWindow = "next_window",
  WhenBudgetAllows = "when_budget",
}

export enum DeliveryStage {
  Accepted = "accepted",
  Transmitted = "transmitted",
  Delivered = "delivered",
  /** Dropped from the outbox because TTL elapsed. */
  Expired = "expired",
}

export interface MessageInput {
  id?: string;
  payload: Uint8Array;
  priority?: Priority;
  ttlMs?: number;
  createdAt?: Date;
  dedupKey?: string;
  maxBytes?: number;
  delivery?: DeliveryMode;
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface Message {
  id: string;
  payload: Uint8Array;
  priority: Priority;
  ttlMs: number;
  createdAt: Date;
  dedupKey?: string;
  maxBytes?: number;
  delivery: DeliveryMode;
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface BudgetConfig {
  dailyBytes: number;
  /**
   * When true (default), failed send attempts count against the daily budget
   * (airtime model). Set false to charge only successful deliveries.
   */
  countFailedAttempts?: boolean;
}

export interface PolicyConfig {
  /** Max send attempts per coverage window before backing off. */
  maxAttemptsPerWindow?: number;
  /** Base backoff in ms for satellite-aware retries. */
  baseBackoffMs?: number;
  /** Cap for exponential backoff (before jitter). */
  maxBackoffMs?: number;
}

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_POLICY: Required<PolicyConfig> = {
  maxAttemptsPerWindow: 3,
  baseBackoffMs: 1000,
  maxBackoffMs: 60_000,
};
