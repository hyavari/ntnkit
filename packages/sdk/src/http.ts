import { LinkState, type Message } from "@ntnkit/core";
import type { HttpTransportOptions, SendResult, Transport } from "./transport.js";

const DEFAULT_TIMEOUT_MS = 15_000;

/** Headers owned by ntnkit — user `headers` cannot override these. */
const RESERVED_HEADERS = new Set([
  "x-ntnkit-message-id",
  "x-ntnkit-metadata",
  "idempotency-key",
]);

export function httpTransport(options: HttpTransportOptions): Transport {
  const linkStateFn = options.linkState ?? (() => LinkState.Terrestrial);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: "http",
    getLinkState: () => linkStateFn(),
    async send(message: Message): Promise<SendResult> {
      const start = Date.now();
      try {
        const res = await fetch(options.url, {
          method: "POST",
          headers: buildHeaders(message, options.headers),
          body: message.payload,
          signal: AbortSignal.timeout(timeoutMs),
        });

        // Drain body so undici can reuse the socket.
        await res.arrayBuffer().catch(() => undefined);

        return {
          delivered: res.ok,
          latencyMs: Date.now() - start,
          statusCode: res.status,
          error: res.ok ? undefined : `HTTP ${res.status}`,
        };
      } catch (err) {
        return {
          delivered: false,
          latencyMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

function buildHeaders(
  message: Message,
  userHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (userHeaders) {
    for (const [key, value] of Object.entries(userHeaders)) {
      if (!RESERVED_HEADERS.has(key.toLowerCase())) {
        headers[key] = value;
      }
    }
  }

  // Ensure a single content-type (case-insensitive).
  deleteHeader(headers, "content-type");
  headers["content-type"] =
    message.contentType ?? "application/octet-stream";

  headers["x-ntnkit-message-id"] = message.id;
  if (message.dedupKey) {
    headers["idempotency-key"] = message.dedupKey;
  }
  if (message.metadata && Object.keys(message.metadata).length > 0) {
    headers["x-ntnkit-metadata"] = JSON.stringify(message.metadata);
  }
  return headers;
}

function deleteHeader(headers: Record<string, string>, name: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      delete headers[key];
    }
  }
}
