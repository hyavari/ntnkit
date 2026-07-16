import { randomUUID } from "node:crypto";
import type { MessageInput, Message } from "./message.js";
import { DEFAULT_TTL_MS, DeliveryMode, Priority } from "./message.js";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const PRIORITIES = new Set<number>([
  Priority.Low,
  Priority.Normal,
  Priority.High,
  Priority.Critical,
]);

const DELIVERY_MODES = new Set<string>(Object.values(DeliveryMode));

/** Printable ASCII (no space/CTL) — safe for HTTP header *names/ids*. */
const HEADER_SAFE = /^[\x21-\x7E]+$/;

/** Printable ASCII including space — for Content-Type values (no CR/LF). */
const HEADER_VALUE_SAFE = /^[\x20-\x7E]+$/;

/** Allow modest clock skew for future createdAt. */
const MAX_CREATED_AT_SKEW_MS = 60 * 60 * 1000;

/** Oldest allowed createdAt relative to now (flush orders oldest-first within a tier). */
const MAX_CREATED_AT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function createMessage(input: MessageInput): Message {
  const payload = input.payload;
  if (!payload || payload.byteLength === 0) {
    throw new ValidationError("payload must not be empty");
  }

  if (input.id !== undefined) {
    if (input.id.length === 0) {
      throw new ValidationError("id must not be empty");
    }
    if (!HEADER_SAFE.test(input.id)) {
      throw new ValidationError(
        "id must be printable ASCII without spaces (header-safe)",
      );
    }
  }

  if (input.ttlMs !== undefined && !(input.ttlMs > 0)) {
    throw new ValidationError("ttlMs must be a positive number");
  }

  if (input.priority !== undefined && !PRIORITIES.has(input.priority)) {
    throw new ValidationError(`invalid priority: ${input.priority}`);
  }

  if (input.delivery !== undefined && !DELIVERY_MODES.has(input.delivery)) {
    throw new ValidationError(`invalid delivery mode: ${input.delivery}`);
  }

  if (input.dedupKey !== undefined) {
    if (input.dedupKey.length === 0) {
      throw new ValidationError("dedupKey must not be empty");
    }
    if (!HEADER_SAFE.test(input.dedupKey)) {
      throw new ValidationError(
        "dedupKey must be printable ASCII without spaces (header-safe)",
      );
    }
  }

  const maxBytes = input.maxBytes;
  if (maxBytes !== undefined) {
    if (!(maxBytes > 0)) {
      throw new ValidationError("maxBytes must be a positive number");
    }
    if (payload.byteLength > maxBytes) {
      throw new ValidationError(
        `payload size ${payload.byteLength} exceeds maxBytes ${maxBytes}`,
      );
    }
  }

  if (input.contentType !== undefined) {
    if (input.contentType.length === 0) {
      throw new ValidationError("contentType must not be empty");
    }
    if (!HEADER_VALUE_SAFE.test(input.contentType)) {
      throw new ValidationError(
        "contentType must be printable ASCII without CR/LF",
      );
    }
  }

  if (input.metadata !== undefined) {
    for (const [key, value] of Object.entries(input.metadata)) {
      if (!HEADER_SAFE.test(key)) {
        throw new ValidationError(
          `metadata key must be printable ASCII without spaces: ${key}`,
        );
      }
      if (!HEADER_VALUE_SAFE.test(value)) {
        throw new ValidationError(
          `metadata value for ${key} must be printable ASCII without CR/LF`,
        );
      }
    }
  }

  const now = Date.now();
  const createdAt = input.createdAt ?? new Date(now);
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    throw new ValidationError("createdAt must be a valid Date");
  }
  if (createdAt.getTime() > now + MAX_CREATED_AT_SKEW_MS) {
    throw new ValidationError(
      "createdAt must not be more than 1 hour in the future",
    );
  }
  if (createdAt.getTime() < now - MAX_CREATED_AT_AGE_MS) {
    throw new ValidationError(
      "createdAt must not be more than 7 days in the past",
    );
  }

  return {
    id: input.id ?? randomUUID(),
    payload,
    priority: input.priority ?? Priority.Normal,
    ttlMs: input.ttlMs ?? DEFAULT_TTL_MS,
    createdAt,
    dedupKey: input.dedupKey,
    maxBytes,
    delivery: input.delivery ?? DeliveryMode.NextWindow,
    contentType: input.contentType,
    metadata: input.metadata,
  };
}

export function isExpired(message: Message, now = Date.now()): boolean {
  return now - message.createdAt.getTime() > message.ttlMs;
}

export function payloadByteLength(message: Message): number {
  return message.payload.byteLength;
}
