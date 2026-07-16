export {
  LinkState,
  Priority,
  DeliveryMode,
  DeliveryStage,
  DEFAULT_TTL_MS,
  DEFAULT_POLICY,
  type Message,
  type MessageInput,
  type BudgetConfig,
  type PolicyConfig,
} from "./message.js";

export { ByteBudget, type BudgetSnapshot } from "./budget.js";
export {
  comparePriority,
  sortForFlush,
  shouldSend,
  satelliteBackoffMs,
  isCritical,
  type PolicyContext,
} from "./policy.js";

export {
  createMessage,
  isExpired,
  payloadByteLength,
  ValidationError,
} from "./validate.js";
