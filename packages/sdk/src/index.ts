export {
  connect,
  type Client,
  type ClientConfig,
  type DeliveryStatusEvent,
  type FlushResult,
} from "./client.js";
export { InMemoryOutbox, type Outbox, type OutboxStats } from "./outbox.js";
export { httpTransport } from "./http.js";
export type {
  Transport,
  SendResult,
  HttpTransportOptions,
} from "./transport.js";

export {
  DeliveryMode,
  DeliveryStage,
  LinkState,
  Priority,
} from "@ntnkit/core";
