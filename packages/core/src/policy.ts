import {
  DeliveryMode,
  LinkState,
  Priority,
  type Message,
  type PolicyConfig,
  DEFAULT_POLICY,
} from "./message.js";
import { isExpired } from "./validate.js";

export interface PolicyContext {
  linkState: LinkState;
  budgetRemainingBytes: number;
  now?: Date;
}

export function comparePriority(a: Message, b: Message): number {
  if (a.priority !== b.priority) {
    return b.priority - a.priority;
  }
  return a.createdAt.getTime() - b.createdAt.getTime();
}

export function sortForFlush(messages: Message[]): Message[] {
  return [...messages].sort(comparePriority);
}

export function shouldSend(message: Message, ctx: PolicyContext): boolean {
  const now = ctx.now ?? new Date();

  if (isExpired(message, now.getTime())) {
    return false;
  }

  const bytes = message.payload.byteLength;

  switch (message.delivery) {
    case DeliveryMode.Immediate:
      if (ctx.linkState === LinkState.Offline) return false;
      // Critical may overspend; others wait for budget.
      return isCritical(message) || ctx.budgetRemainingBytes >= bytes;

    case DeliveryMode.WhenBudgetAllows:
      // Strict quota mode — even critical waits for budget.
      return (
        ctx.linkState !== LinkState.Offline &&
        ctx.budgetRemainingBytes >= bytes
      );

    case DeliveryMode.NextWindow:
      if (ctx.linkState !== LinkState.SatelliteWindowOpen) return false;
      return isCritical(message) || ctx.budgetRemainingBytes >= bytes;

    default: {
      const _exhaustive: never = message.delivery;
      void _exhaustive;
      return false;
    }
  }
}

/**
 * Exponential backoff with full jitter to avoid retry herds at window open.
 * Returns a delay in [1, min(base*2^attempt, maxBackoff)] when the ceiling
 * is positive (never 0 — avoids back-to-back retry storms).
 */
export function satelliteBackoffMs(
  attempt: number,
  policy: PolicyConfig = {},
  random: () => number = Math.random,
): number {
  const base = policy.baseBackoffMs ?? DEFAULT_POLICY.baseBackoffMs;
  const max = policy.maxBackoffMs ?? DEFAULT_POLICY.maxBackoffMs;
  const ceiling = Math.min(base * 2 ** Math.max(0, attempt), max);
  if (ceiling <= 0) return 0;
  // random() expected in [0, 1); result in [1, ceiling].
  const unit = Math.min(Math.max(random(), 0), 1 - Number.EPSILON);
  return 1 + Math.floor(unit * ceiling);
}

/** True when priority is Critical (may bypass byte budget). */
export function isCritical(message: Message): boolean {
  return message.priority === Priority.Critical;
}
