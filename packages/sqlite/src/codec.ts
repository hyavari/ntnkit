import type {
  DeliveryMode,
  Message,
  Priority,
} from "@ntnkit/core";

export interface MessageRow {
  id: string;
  payload: Buffer;
  priority: number;
  ttl_ms: number;
  created_at_ms: number;
  dedup_key: string | null;
  max_bytes: number | null;
  delivery: string;
  content_type: string | null;
  metadata_json: string | null;
}

export function messageToRow(message: Message): MessageRow {
  return {
    id: message.id,
    payload: Buffer.from(message.payload),
    priority: message.priority,
    ttl_ms: message.ttlMs,
    created_at_ms: message.createdAt.getTime(),
    dedup_key: message.dedupKey ?? null,
    max_bytes: message.maxBytes ?? null,
    delivery: message.delivery,
    content_type: message.contentType ?? null,
    metadata_json: message.metadata
      ? JSON.stringify(message.metadata)
      : null,
  };
}

export function rowToMessage(row: MessageRow): Message {
  const message: Message = {
    id: row.id,
    payload: new Uint8Array(row.payload),
    priority: row.priority as Priority,
    ttlMs: row.ttl_ms,
    createdAt: new Date(row.created_at_ms),
    delivery: row.delivery as DeliveryMode,
  };
  if (row.dedup_key != null) message.dedupKey = row.dedup_key;
  if (row.max_bytes != null) message.maxBytes = row.max_bytes;
  if (row.content_type != null) message.contentType = row.content_type;
  if (row.metadata_json != null) {
    message.metadata = JSON.parse(row.metadata_json) as Record<string, string>;
  }
  return message;
}
