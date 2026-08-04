import { LinkState } from "@ntnkit/core";

export interface NtnboxLinkStateOptions {
  /** Base URL for the ntnbox API host (no trailing slash required). */
  apiBaseUrl: string;
  /** Device id registered by ntnbox (default: sandbox-0). */
  deviceId?: string;
  /** Condition poll interval in ms (default: 1000). */
  pollIntervalMs?: number;
  /** Delay before SSE reconnect after disconnect (default: 1000). */
  sseReconnectMs?: number;
  /** Condition/SSE request timeout in ms (default: 5000). */
  requestTimeoutMs?: number;
  /** When false, only condition polling is used (default: true). */
  sse?: boolean;
  /**
   * When true, prefer ntnbox `selected_bearer` / handover SSE and map
   * terrestrial → {@link LinkState.Terrestrial} (default: false).
   */
  terrestrialFallback?: boolean;
  /** Injectable fetch for tests. */
  fetch?: typeof fetch;
}

export interface NtnboxLinkState {
  getLinkState(): Promise<LinkState>;
  close(): Promise<void>;
}

const DEFAULT_DEVICE_ID = "sandbox-0";
const DEFAULT_POLL_MS = 1000;
const DEFAULT_SSE_RECONNECT_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

interface ConditionBody {
  in_coverage?: unknown;
  selected_bearer?: unknown;
}

interface CoverageEventBody {
  kind?: unknown;
  in_coverage?: unknown;
  device_id?: unknown;
}

interface HandoverEventBody {
  to?: unknown;
  device_id?: unknown;
}

/**
 * Observes ntnbox condition polling and coverage SSE events, mapping them to
 * ntnkit {@link LinkState} for use with `httpTransport({ linkState })`.
 */
export function ntnboxLinkState(
  options: NtnboxLinkStateOptions,
): NtnboxLinkState {
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const deviceId = options.deviceId ?? DEFAULT_DEVICE_ID;
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const sseReconnectMs = options.sseReconnectMs ?? DEFAULT_SSE_RECONNECT_MS;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const sseEnabled = options.sse !== false;
  const terrestrialFallback = options.terrestrialFallback === true;
  const base = options.apiBaseUrl.replace(/\/+$/, "");
  const conditionUrl = `${base}/devices/${encodeURIComponent(deviceId)}/condition`;
  const eventsUrl = `${base}/events`;

  let current: LinkState = LinkState.Offline;
  let hasObservation = false;
  let closed = false;
  let started = false;
  let startPromise: Promise<void> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let abort: AbortController | undefined;
  let pollInFlight = false;
  let pollGeneration = 0;

  function mapCoverage(inCoverage: boolean): LinkState {
    return inCoverage
      ? LinkState.SatelliteWindowOpen
      : LinkState.Constrained;
  }

  function mapBearer(bearer: string): LinkState | undefined {
    if (bearer === "satellite") return LinkState.SatelliteWindowOpen;
    if (bearer === "terrestrial") return LinkState.Terrestrial;
    return undefined;
  }

  function setCoverage(inCoverage: boolean): void {
    current = mapCoverage(inCoverage);
    hasObservation = true;
  }

  function setBearer(bearer: string): boolean {
    const mapped = mapBearer(bearer);
    if (mapped === undefined) return false;
    current = mapped;
    hasObservation = true;
    return true;
  }

  function onObservationFailure(): void {
    // Keep last known coverage across transient API failures so callers do not
    // flap Offline↔open (which clears per-window attempt budgets in connect()).
    if (!hasObservation) {
      current = LinkState.Offline;
    }
  }

  async function refreshCondition(signal?: AbortSignal): Promise<void> {
    if (closed || pollInFlight) return;
    pollInFlight = true;
    const generation = ++pollGeneration;
    try {
      const res = await fetchFn(conditionUrl, {
        signal: withTimeout(signal, requestTimeoutMs),
        headers: { accept: "application/json" },
      });
      if (closed || generation !== pollGeneration) return;
      if (!res.ok) {
        onObservationFailure();
        return;
      }
      const body = (await res.json()) as ConditionBody;
      if (closed || generation !== pollGeneration) return;
      if (terrestrialFallback) {
        applyTerrestrialCondition(body);
        return;
      }
      if (typeof body.in_coverage !== "boolean") {
        onObservationFailure();
        return;
      }
      setCoverage(body.in_coverage);
    } catch (err) {
      if (closed || isAbortError(err) || generation !== pollGeneration) return;
      onObservationFailure();
    } finally {
      if (generation === pollGeneration) {
        pollInFlight = false;
      }
    }
  }

  function applyCoverageEvent(raw: string): void {
    let parsed: CoverageEventBody;
    try {
      parsed = JSON.parse(raw) as CoverageEventBody;
    } catch {
      return;
    }

    if (
      typeof parsed.device_id === "string" &&
      parsed.device_id !== "" &&
      parsed.device_id !== deviceId
    ) {
      return;
    }

    if (typeof parsed.in_coverage === "boolean") {
      if (terrestrialFallback) {
        // Dual-path: coverage is a bearer hint (sat open ↔ satellite, else terr).
        current = parsed.in_coverage
          ? LinkState.SatelliteWindowOpen
          : LinkState.Terrestrial;
        hasObservation = true;
        return;
      }
      setCoverage(parsed.in_coverage);
      return;
    }

    if (parsed.kind === "window_opened") {
      if (terrestrialFallback) {
        current = LinkState.SatelliteWindowOpen;
        hasObservation = true;
        return;
      }
      setCoverage(true);
      return;
    }
    if (parsed.kind === "window_closed") {
      if (terrestrialFallback) {
        current = LinkState.Terrestrial;
        hasObservation = true;
        return;
      }
      setCoverage(false);
    }
  }

  function applyTerrestrialCondition(body: ConditionBody): void {
    const inCoverage =
      typeof body.in_coverage === "boolean" ? body.in_coverage : undefined;
    const bearer =
      typeof body.selected_bearer === "string" ? body.selected_bearer : undefined;
    const mapped = bearer !== undefined ? mapBearer(bearer) : undefined;

    if (inCoverage !== undefined && mapped !== undefined) {
      // Prefer in_coverage when it disagrees with selected_bearer (stale route).
      if (
        (bearer === "satellite" && !inCoverage) ||
        (bearer === "terrestrial" && inCoverage)
      ) {
        current = inCoverage
          ? LinkState.SatelliteWindowOpen
          : LinkState.Terrestrial;
        hasObservation = true;
        return;
      }
      current = mapped;
      hasObservation = true;
      return;
    }
    if (mapped !== undefined) {
      current = mapped;
      hasObservation = true;
      return;
    }
    if (inCoverage !== undefined) {
      // Dual-path: satellite outage means terrestrial even without bearer.
      current = inCoverage
        ? LinkState.SatelliteWindowOpen
        : LinkState.Terrestrial;
      hasObservation = true;
      return;
    }
    onObservationFailure();
  }

  function applyHandoverEvent(raw: string): void {
    if (!terrestrialFallback) return;
    let parsed: HandoverEventBody;
    try {
      parsed = JSON.parse(raw) as HandoverEventBody;
    } catch {
      return;
    }
    if (
      typeof parsed.device_id === "string" &&
      parsed.device_id !== "" &&
      parsed.device_id !== deviceId
    ) {
      return;
    }
    if (typeof parsed.to === "string") {
      setBearer(parsed.to);
    }
  }

  async function runSse(signal: AbortSignal): Promise<void> {
    while (!closed && !signal.aborted) {
      try {
        const res = await fetchFn(eventsUrl, {
          signal,
          headers: { accept: "text/event-stream" },
        });
        if (closed || signal.aborted) return;
        if (!res.ok || !res.body) {
          await sleep(sseReconnectMs, signal);
          continue;
        }
        await readSse(res.body, signal, (event, data) => {
          if (event === "coverage") applyCoverageEvent(data);
          if (event === "handover") applyHandoverEvent(data);
        });
        if (closed || signal.aborted) return;
        await sleep(sseReconnectMs, signal);
      } catch (err) {
        if (closed || signal.aborted || isAbortError(err)) return;
        await sleep(sseReconnectMs, signal);
      }
    }
  }

  async function ensureStarted(): Promise<void> {
    if (closed) return;
    if (started) return;
    if (startPromise) {
      await startPromise;
      return;
    }

    startPromise = (async () => {
      if (closed) return;
      abort = new AbortController();
      await refreshCondition(abort.signal);
      if (closed) return;
      started = true;
      pollTimer = setInterval(() => {
        void refreshCondition(abort?.signal);
      }, pollMs);
      if (typeof pollTimer === "object" && "unref" in pollTimer) {
        (pollTimer as NodeJS.Timeout).unref();
      }
      if (sseEnabled) {
        void runSse(abort.signal);
      }
    })();

    await startPromise;
  }

  return {
    async getLinkState(): Promise<LinkState> {
      if (closed) return LinkState.Offline;
      await ensureStarted();
      return current;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      pollGeneration += 1;
      pollInFlight = false;
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      abort?.abort();
      abort = undefined;
      current = LinkState.Offline;
      hasObservation = false;
    },
  };
}

function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  if (timeoutMs <= 0) {
    return signal ?? new AbortController().signal;
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError")) ||
    (typeof DOMException !== "undefined" &&
      err instanceof DOMException &&
      err.name === "AbortError")
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: string, data: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line === "") {
          if (dataLines.length > 0) {
            onEvent(eventName, dataLines.join("\n"));
          }
          eventName = "message";
          dataLines = [];
        } else if (!line.startsWith(":")) {
          if (line.startsWith("event:")) {
            eventName = line.slice("event:".length).trim();
          } else if (line.startsWith("data:")) {
            const valuePart = line.slice("data:".length);
            dataLines.push(
              valuePart.startsWith(" ") ? valuePart.slice(1) : valuePart,
            );
          }
        }

        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be cancelled.
    }
  }
}
