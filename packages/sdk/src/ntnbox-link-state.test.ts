import { describe, expect, it, vi } from "vitest";
import { LinkState } from "@ntnkit/core";
import { ntnboxLinkState } from "./ntnbox-link-state.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]));
      i += 1;
    },
  });
}

function idleSseResponse(): Response {
  return new Response(
    new ReadableStream({
      start() {
        // Remains open until cancelled by AbortSignal.
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

describe("ntnboxLinkState", () => {
  it("maps in_coverage true to SatelliteWindowOpen", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/condition")) {
        return jsonResponse({ in_coverage: true, elapsed_sec: 1 });
      }
      return new Response(null, { status: 503 });
    });

    const link = ntnboxLinkState({
      apiBaseUrl: "http://ntnbox.test",
      fetch: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 60_000,
      sse: false,
    });

    try {
      await expect(link.getLinkState()).resolves.toBe(
        LinkState.SatelliteWindowOpen,
      );
    } finally {
      await link.close();
    }
  });

  it("maps in_coverage false to Constrained", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/condition")) {
        return jsonResponse({ in_coverage: false });
      }
      return new Response(null, { status: 503 });
    });

    const link = ntnboxLinkState({
      apiBaseUrl: "http://ntnbox.test/",
      deviceId: "sandbox-0",
      fetch: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 60_000,
      sse: false,
    });

    try {
      await expect(link.getLinkState()).resolves.toBe(LinkState.Constrained);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        "http://ntnbox.test/devices/sandbox-0/condition",
      );
    } finally {
      await link.close();
    }
  });

  it("returns Offline when condition request fails", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("network down");
    });

    const link = ntnboxLinkState({
      apiBaseUrl: "http://ntnbox.test",
      fetch: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 60_000,
      sse: false,
    });

    try {
      await expect(link.getLinkState()).resolves.toBe(LinkState.Offline);
    } finally {
      await link.close();
    }
  });

  it("returns Offline for malformed condition payloads", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/condition")) {
        return jsonResponse({ elapsed_sec: 1 });
      }
      return new Response(null, { status: 503 });
    });

    const link = ntnboxLinkState({
      apiBaseUrl: "http://ntnbox.test",
      fetch: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 60_000,
      sse: false,
    });

    try {
      await expect(link.getLinkState()).resolves.toBe(LinkState.Offline);
    } finally {
      await link.close();
    }
  });

  it("updates from coverage SSE events", async () => {
    let eventsCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/condition")) {
        return jsonResponse({ in_coverage: false });
      }
      if (url.endsWith("/events")) {
        eventsCalls += 1;
        if (eventsCalls > 1) return idleSseResponse();
        return new Response(
          new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder();
              await new Promise((r) => setTimeout(r, 30));
              controller.enqueue(
                encoder.encode(
                  'event: coverage\ndata: {"kind":"window_opened","in_coverage":true}\n\n',
                ),
              );
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      }
      return new Response(null, { status: 404 });
    });

    const link = ntnboxLinkState({
      apiBaseUrl: "http://ntnbox.test",
      fetch: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 60_000,
      sseReconnectMs: 10,
    });

    try {
      await expect(link.getLinkState()).resolves.toBe(LinkState.Constrained);

      await vi.waitFor(async () => {
        expect(await link.getLinkState()).toBe(LinkState.SatelliteWindowOpen);
      });
    } finally {
      await link.close();
    }
  });

  it("ignores malformed SSE payloads", async () => {
    let eventsCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/condition")) {
        return jsonResponse({ in_coverage: false });
      }
      if (url.endsWith("/events")) {
        eventsCalls += 1;
        if (eventsCalls > 1) return idleSseResponse();
        return new Response(
          sseStream([
            "event: coverage\ndata: not-json\n\n",
            'event: coverage\ndata: {"kind":"window_closed"}\n\n',
          ]),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      }
      return new Response(null, { status: 404 });
    });

    const link = ntnboxLinkState({
      apiBaseUrl: "http://ntnbox.test",
      fetch: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 60_000,
      sseReconnectMs: 10,
    });

    try {
      await expect(link.getLinkState()).resolves.toBe(LinkState.Constrained);
      await new Promise((r) => setTimeout(r, 20));
      await expect(link.getLinkState()).resolves.toBe(LinkState.Constrained);
    } finally {
      await link.close();
    }
  });

  it("returns Offline after close", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/condition")) {
        return jsonResponse({ in_coverage: true });
      }
      return new Response(null, { status: 503 });
    });

    const link = ntnboxLinkState({
      apiBaseUrl: "http://ntnbox.test",
      fetch: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 60_000,
      sse: false,
    });

    await expect(link.getLinkState()).resolves.toBe(
      LinkState.SatelliteWindowOpen,
    );
    await link.close();
    await expect(link.getLinkState()).resolves.toBe(LinkState.Offline);
  });

  it("keeps last known coverage across transient poll failures", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/condition")) {
        calls += 1;
        if (calls === 1) {
          return jsonResponse({ in_coverage: true });
        }
        throw new TypeError("network down");
      }
      return new Response(null, { status: 503 });
    });

    const link = ntnboxLinkState({
      apiBaseUrl: "http://ntnbox.test",
      fetch: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 20,
      sse: false,
    });

    try {
      await expect(link.getLinkState()).resolves.toBe(
        LinkState.SatelliteWindowOpen,
      );
      await vi.waitFor(() => {
        expect(calls).toBeGreaterThan(1);
      });
      await expect(link.getLinkState()).resolves.toBe(
        LinkState.SatelliteWindowOpen,
      );
    } finally {
      await link.close();
    }
  });

  it("ignores coverage SSE events for other devices", async () => {
    let eventsCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/condition")) {
        return jsonResponse({ in_coverage: false });
      }
      if (url.endsWith("/events")) {
        eventsCalls += 1;
        if (eventsCalls > 1) return idleSseResponse();
        return new Response(
          sseStream([
            'event: coverage\ndata: {"kind":"window_opened","in_coverage":true,"device_id":"sandbox-1"}\n\n',
          ]),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      }
      return new Response(null, { status: 404 });
    });

    const link = ntnboxLinkState({
      apiBaseUrl: "http://ntnbox.test",
      deviceId: "sandbox-0",
      fetch: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 60_000,
      sseReconnectMs: 10,
    });

    try {
      await expect(link.getLinkState()).resolves.toBe(LinkState.Constrained);
      await new Promise((r) => setTimeout(r, 30));
      await expect(link.getLinkState()).resolves.toBe(LinkState.Constrained);
    } finally {
      await link.close();
    }
  });
});
