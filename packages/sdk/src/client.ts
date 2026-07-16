import {
  ByteBudget,
  DEFAULT_POLICY,
  DeliveryStage,
  LinkState,
  isCritical,
  satelliteBackoffMs,
  shouldSend,
  type BudgetConfig,
  type Message,
  type MessageInput,
  type PolicyConfig,
  createMessage,
} from "@ntnkit/core";
import { InMemoryOutbox, type Outbox } from "./outbox.js";
import type { Transport } from "./transport.js";

export interface DeliveryStatusEvent {
  id: string;
  stage: DeliveryStage;
}

export interface ClientConfig {
  transport: Transport;
  budget?: BudgetConfig;
  policy?: PolicyConfig;
  /**
   * Outbox instance. Must not be shared across clients — each `connect()`
   * owns exclusive access until `close()`.
   */
  outbox?: Outbox;
  /**
   * Delivery-stage notifications.
   *
   * Timing: invoked only after the client lock is released, so handlers may
   * call `send` / `flush` / `close` without deadlocking. Events from one
   * locked operation are delivered in order as a batch; a handler that starts
   * another client call (without awaiting it) may interleave that call's
   * later status events after this batch.
   *
   * Async handlers are not awaited — `send()` / `flush()` may resolve before
   * a promise returned from `onStatus` settles. Await your own follow-up work
   * if you need it finished before continuing.
   *
   * Callback errors (sync throws and rejected promises) are swallowed so hooks
   * cannot break delivery or crash the process.
   *
   * - `accepted` — message persisted in the outbox (every send enqueues first,
   *   including Immediate; success then removes it)
   * - `transmitted` — transport returned a result (not emitted if it throws)
   * - `delivered` — remote ack / success (removed from outbox)
   * - `expired` — dropped from the outbox because TTL elapsed
   */
  onStatus?: (event: DeliveryStatusEvent) => void;
}

export interface FlushResult {
  sent: number;
  deferred: number;
  failed: number;
}

export interface Client {
  send(input: MessageInput): Promise<string>;
  flush(): Promise<FlushResult>;
  stats(): {
    outbox: ReturnType<Outbox["stats"]>;
    budget: ReturnType<ByteBudget["snapshot"]>;
  };
  /** Release exclusive outbox ownership and reject further operations. */
  close(): Promise<void>;
}

type DeliverOutcome = "sent" | "deferred" | "failed";

interface AttemptState {
  attempts: number;
  nextAllowedAt: number;
}

const claimedOutboxes = new WeakSet<Outbox>();

export async function connect(config: ClientConfig): Promise<Client> {
  const ownsExternalOutbox = config.outbox !== undefined;
  const outbox = config.outbox ?? new InMemoryOutbox();
  if (ownsExternalOutbox) {
    if (claimedOutboxes.has(outbox)) {
      throw new Error(
        "Outbox instance is already owned by another ntnkit client",
      );
    }
    claimedOutboxes.add(outbox);
  }

  const budget = new ByteBudget(
    config.budget ?? { dailyBytes: Number.MAX_SAFE_INTEGER },
  );
  const policy: Required<PolicyConfig> = {
    ...DEFAULT_POLICY,
    ...config.policy,
  };
  const attempts = new Map<string, AttemptState>();
  let lastLinkState: LinkState | null = null;
  let gate: Promise<void> = Promise.resolve();
  let closed = false;
  /** Status events queued while the lock is held; flushed after release. */
  const pendingStatus: DeliveryStatusEvent[] = [];

  function emit(id: string, stage: DeliveryStage): void {
    pendingStatus.push({ id, stage });
  }

  function flushStatus(): void {
    if (!config.onStatus || pendingStatus.length === 0) {
      pendingStatus.length = 0;
      return;
    }
    const events = pendingStatus.splice(0, pendingStatus.length);
    const onStatus = config.onStatus;
    for (const event of events) {
      try {
        void Promise.resolve(onStatus(event)).catch(() => {
          // User hooks must not break the delivery pipeline.
        });
      } catch {
        // Sync throw before a thenable is returned.
      }
    }
  }

  function assertOpen(): void {
    if (closed) {
      throw new Error("client is closed");
    }
  }

  function emitExpired(now = Date.now()): void {
    for (const msg of outbox.pruneExpired(now)) {
      clearAttempt(msg.id);
      emit(msg.id, DeliveryStage.Expired);
    }
  }

  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = gate;
    let release!: () => void;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
      // After release so onStatus may re-enter send/flush/close safely.
      flushStatus();
    }
  }

  function onLinkState(linkState: LinkState): void {
    if (
      linkState === LinkState.SatelliteWindowOpen &&
      lastLinkState !== LinkState.SatelliteWindowOpen
    ) {
      attempts.clear();
    }
    lastLinkState = linkState;
  }

  function clearAttempt(id: string): void {
    attempts.delete(id);
  }

  function markDelivered(message: Message): void {
    outbox.remove(message.id);
    if (message.dedupKey) {
      const staleId = outbox.removeByDedupKey(message.dedupKey);
      if (staleId) clearAttempt(staleId);
    }
    clearAttempt(message.id);
    emit(message.id, DeliveryStage.Delivered);
  }

  function chargeBudget(
    bytes: number,
    critical: boolean,
    delivered: boolean,
  ): void {
    if (delivered) {
      // Critical may overspend; non-critical was gated by canSpend above.
      budget.spend(bytes, new Date(), critical);
      return;
    }
    if (budget.countFailedAttempts) {
      // Airtime model: always allow charging past the cap.
      budget.spend(bytes, new Date(), true);
    }
  }

  async function tryDeliver(message: Message): Promise<DeliverOutcome> {
    const linkState = await config.transport.getLinkState();
    onLinkState(linkState);

    const state = attempts.get(message.id);
    const inWindow = linkState === LinkState.SatelliteWindowOpen;

    if (
      inWindow &&
      state &&
      state.attempts >= policy.maxAttemptsPerWindow
    ) {
      return "deferred";
    }
    if (state && Date.now() < state.nextAllowedAt) {
      return "deferred";
    }

    if (
      !shouldSend(message, {
        linkState,
        budgetRemainingBytes: budget.remaining(),
      })
    ) {
      return "deferred";
    }

    const bytes = message.payload.byteLength;
    const critical = isCritical(message);
    if (!critical && !budget.canSpend(bytes)) {
      return "deferred";
    }

    let result;
    let transmitted = false;
    try {
      result = await config.transport.send(message);
      transmitted = true;
    } catch (err) {
      result = {
        delivered: false as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Only emit Transmitted when the transport returned (bits left / ack path).
    if (transmitted) {
      emit(message.id, DeliveryStage.Transmitted);
    }
    chargeBudget(bytes, critical, result.delivered);

    if (result.delivered) {
      markDelivered(message);
      return "sent";
    }

    const nextAttempts = (state?.attempts ?? 0) + 1;
    attempts.set(message.id, {
      attempts: nextAttempts,
      nextAllowedAt: Date.now() + satelliteBackoffMs(nextAttempts - 1, policy),
    });
    return "failed";
  }

  return {
    async send(input: MessageInput): Promise<string> {
      return withLock(async () => {
        assertOpen();
        emitExpired();
        const message = createMessage(input);
        // Store-and-forward: always enqueue first (including Immediate) so
        // Accepted means persisted. Success removes via markDelivered; if
        // tryDeliver throws, the message remains queued for a later flush.
        const replacedId = outbox.enqueue(message);
        if (replacedId) clearAttempt(replacedId);
        emit(message.id, DeliveryStage.Accepted);

        await tryDeliver(message);
        return message.id;
      });
    },

    async flush(): Promise<FlushResult> {
      return withLock(async () => {
        assertOpen();
        emitExpired();
        let sent = 0;
        let deferred = 0;
        let failed = 0;

        const queue = outbox.list();
        for (const id of attempts.keys()) {
          if (!outbox.has(id)) clearAttempt(id);
        }

        // Continue after failures so later Critical/queued messages still get
        // an attempt in the same pass (short satellite windows).
        for (const message of queue) {
          if (!outbox.has(message.id)) {
            deferred += 1;
            continue;
          }

          const outcome = await tryDeliver(message);
          switch (outcome) {
            case "sent":
              sent += 1;
              break;
            case "deferred":
              deferred += 1;
              break;
            case "failed":
              failed += 1;
              break;
            default: {
              const _exhaustive: never = outcome;
              void _exhaustive;
            }
          }
        }

        return { sent, deferred, failed };
      });
    },

    stats() {
      assertOpen();
      // Does not prune/emit expired — that runs under the lock on send/flush.
      return {
        outbox: outbox.stats(),
        budget: budget.snapshot(),
      };
    },

    async close(): Promise<void> {
      return withLock(async () => {
        if (closed) return;
        closed = true;
        attempts.clear();
        if (ownsExternalOutbox) {
          claimedOutboxes.delete(outbox);
        }
      });
    },
  };
}
