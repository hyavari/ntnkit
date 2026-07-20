import type { Outbox } from "./outbox.js";

export interface AttemptState {
  attempts: number;
  nextAllowedAt: number;
}

/**
 * Durable backing store for outbox messages plus retry/budget state.
 * Implemented by `@ntnkit/sqlite`; kept in sdk so the client can hydrate
 * without depending on native bindings.
 */
export interface DurableStore {
  outbox: Outbox;
  loadAttempts(): Promise<ReadonlyMap<string, AttemptState>>;
  saveAttempt(id: string, state: AttemptState): Promise<void>;
  clearAttempt(id: string): Promise<void>;
  clearAllAttempts(): Promise<void>;
  loadBudget(): Promise<{ dayKey: string; usedBytes: number } | null>;
  saveBudget(state: { dayKey: string; usedBytes: number }): Promise<void>;
  close(): Promise<void>;
}
