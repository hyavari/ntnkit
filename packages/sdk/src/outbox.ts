import {
  type Message,
  isExpired,
  sortForFlush,
} from "@ntnkit/core";

export interface OutboxStats {
  depth: number;
  oldestAgeMs: number | null;
}

/** Pluggable outbox storage. */
export interface Outbox {
  /** Enqueue; returns id of any *other* message replaced by dedupKey. */
  enqueue(message: Message): string | undefined;
  remove(id: string): boolean;
  /** Remove the message currently indexed by dedupKey; returns its id. */
  removeByDedupKey(dedupKey: string): string | undefined;
  has(id: string): boolean;
  /**
   * Drop expired messages and return them (for status emission).
   * `list` also prunes; `stats` does not.
   */
  pruneExpired(now?: number): Message[];
  list(now?: number): Message[];
  stats(now?: number): OutboxStats;
}

export class InMemoryOutbox implements Outbox {
  private readonly messages = new Map<string, Message>();
  private readonly dedupIndex = new Map<string, string>();

  enqueue(message: Message): string | undefined {
    let replacedId: string | undefined;

    // Same-id overwrite: drop the previous row's dedup mapping if the key changed.
    const prior = this.messages.get(message.id);
    if (prior?.dedupKey && prior.dedupKey !== message.dedupKey) {
      this.clearDedupIfPointsTo(prior.dedupKey, message.id);
    }

    if (message.dedupKey) {
      const existingId = this.dedupIndex.get(message.dedupKey);
      if (existingId && existingId !== message.id) {
        this.remove(existingId);
        replacedId = existingId;
      }
      this.dedupIndex.set(message.dedupKey, message.id);
    } else if (prior?.dedupKey) {
      // Replacement has no dedupKey — clear the old mapping for this id.
      this.clearDedupIfPointsTo(prior.dedupKey, message.id);
    }

    this.messages.set(message.id, message);
    return replacedId;
  }

  remove(id: string): boolean {
    const msg = this.messages.get(id);
    if (!msg) return false;
    this.messages.delete(id);
    if (msg.dedupKey) {
      this.clearDedupIfPointsTo(msg.dedupKey, id);
    }
    return true;
  }

  removeByDedupKey(dedupKey: string): string | undefined {
    const id = this.dedupIndex.get(dedupKey);
    if (id === undefined) return undefined;
    // Always drop the index entry, even if the message row is already gone.
    this.dedupIndex.delete(dedupKey);
    const msg = this.messages.get(id);
    if (msg) {
      this.messages.delete(id);
      if (msg.dedupKey && msg.dedupKey !== dedupKey) {
        this.clearDedupIfPointsTo(msg.dedupKey, id);
      }
    }
    return id;
  }

  has(id: string): boolean {
    return this.messages.has(id);
  }

  pruneExpired(now = Date.now()): Message[] {
    const expired: Message[] = [];
    for (const [id, msg] of this.messages) {
      if (isExpired(msg, now)) {
        expired.push(msg);
        this.remove(id);
      }
    }
    return expired;
  }

  list(now = Date.now()): Message[] {
    this.pruneExpired(now);
    return sortForFlush([...this.messages.values()]);
  }

  /** Snapshot only — does not prune (call `pruneExpired` / `list` to drop TTL). */
  stats(now = Date.now()): OutboxStats {
    if (this.messages.size === 0) {
      return { depth: 0, oldestAgeMs: null };
    }
    let oldest = Number.POSITIVE_INFINITY;
    for (const msg of this.messages.values()) {
      const t = msg.createdAt.getTime();
      if (t < oldest) oldest = t;
    }
    return {
      depth: this.messages.size,
      oldestAgeMs: now - oldest,
    };
  }

  private clearDedupIfPointsTo(dedupKey: string, id: string): void {
    if (this.dedupIndex.get(dedupKey) === id) {
      this.dedupIndex.delete(dedupKey);
    }
  }
}
