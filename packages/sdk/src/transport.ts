import type { LinkState, Message } from "@ntnkit/core";

export interface SendResult {
  delivered: boolean;
  latencyMs?: number;
  statusCode?: number;
  error?: string;
}

export interface Transport {
  readonly name: string;
  getLinkState(): LinkState | Promise<LinkState>;
  send(message: Message): Promise<SendResult>;
}

export interface HttpTransportOptions {
  /** POST target; payload sent as raw body. */
  url: string;
  headers?: Record<string, string>;
  /** Request timeout in ms (default 15_000). */
  timeoutMs?: number;
  /** Optional hook to derive link state (default: terrestrial). */
  linkState?: () => LinkState | Promise<LinkState>;
}
