import type { BudgetConfig } from "./message.js";

export interface BudgetSnapshot {
  dailyBytes: number;
  /** Bytes charged today, capped at dailyBytes for display. */
  usedBytes: number;
  remainingBytes: number;
  /** Bytes charged beyond the daily cap (failed-attempt airtime / critical). */
  overspentBytes: number;
  dayKey: string;
}

export class ByteBudget {
  private usedBytes = 0;
  private dayKey: string;
  readonly countFailedAttempts: boolean;

  constructor(private readonly config: BudgetConfig) {
    this.dayKey = utcDayKey();
    this.countFailedAttempts = config.countFailedAttempts !== false;
  }

  canSpend(bytes: number, now = new Date()): boolean {
    this.rollDayIfNeeded(now);
    return this.usedBytes + bytes <= this.config.dailyBytes;
  }

  spend(bytes: number, now = new Date(), allowOverspend = false): void {
    this.rollDayIfNeeded(now);
    if (!allowOverspend && !this.canSpend(bytes, now)) {
      throw new Error(
        `budget exceeded: need ${bytes} bytes, ${this.remaining(now)} remaining`,
      );
    }
    this.usedBytes += bytes;
  }

  remaining(now = new Date()): number {
    this.rollDayIfNeeded(now);
    return Math.max(0, this.config.dailyBytes - this.usedBytes);
  }

  snapshot(now = new Date()): BudgetSnapshot {
    this.rollDayIfNeeded(now);
    const overspentBytes = Math.max(
      0,
      this.usedBytes - this.config.dailyBytes,
    );
    return {
      dailyBytes: this.config.dailyBytes,
      usedBytes: Math.min(this.usedBytes, this.config.dailyBytes),
      remainingBytes: this.remaining(now),
      overspentBytes,
      dayKey: this.dayKey,
    };
  }

  /**
   * Restore persisted counters. If `dayKey` is not today's UTC day, usage
   * resets to 0 for the current day.
   */
  restore(
    state: { dayKey: string; usedBytes: number },
    now = new Date(),
  ): void {
    const key = utcDayKey(now);
    if (state.dayKey !== key) {
      this.dayKey = key;
      this.usedBytes = 0;
      return;
    }
    this.dayKey = state.dayKey;
    this.usedBytes = state.usedBytes;
  }

  /** Uncapped counters for durable persistence (may exceed dailyBytes). */
  durableState(now = new Date()): { dayKey: string; usedBytes: number } {
    this.rollDayIfNeeded(now);
    return { dayKey: this.dayKey, usedBytes: this.usedBytes };
  }

  private rollDayIfNeeded(now: Date): void {
    const key = utcDayKey(now);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.usedBytes = 0;
    }
  }
}

function utcDayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
