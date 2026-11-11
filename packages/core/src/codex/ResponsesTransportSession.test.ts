import {
  ResponsesTransportPolicy,
  ResponsesTransportSession,
} from "./ResponsesTransportSession.js";
import { describe, expect, it, vi } from "vitest";

const input = [{ type: "message", role: "user", content: "hello" }];
const output = [
  { type: "reasoning", id: "reasoning-a", encrypted_content: "opaque" },
  {
    type: "function_call",
    id: "call-a",
    call_id: "tool-a",
    name: "test",
    arguments: "{}",
  },
];
const body = {
  type: "response.create",
  model: "gpt-5.5",
  input,
  tools: [],
  store: false,
};

function completed(session: ResponsesTransportSession) {
  session.captureCompletion(body, {
    type: "response.completed",
    response: { id: "response-a", status: "completed", output },
  });
}

describe("ResponsesTransportSession continuation", () => {
  it("sends only an exact tail including opaque output items on the same chain", () => {
    const session = new ResponsesTransportSession();
    completed(session);
    const tail = {
      type: "function_call_output",
      call_id: "tool-a",
      output: "result",
    };
    const result = session.prepareBody({
      ...body,
      input: [...input, ...output, tail],
    });
    expect(result).toEqual({
      incremental: true,
      body: { ...body, previous_response_id: "response-a", input: [tail] },
    });
    session.dispose();
  });

  it.each([
    { ...body, instructions: "changed", input: [...input, ...output] },
    {
      ...body,
      input: [
        ...input,
        { ...output[0], encrypted_content: "different" },
        output[1],
      ],
    },
    { ...body, input: [] },
    {
      ...body,
      tools: [{ type: "function", name: "changed" }],
      input: [...input, ...output],
    },
  ])("starts a full chain when properties or replay change (%#)", (next) => {
    const session = new ResponsesTransportSession();
    completed(session);
    expect(session.prepareBody(next)).toEqual({
      body: next,
      incremental: false,
    });
    session.dispose();
  });

  it("rejects oversized replay before serializing or cloning its image payload", () => {
    const session = new ResponsesTransportSession();
    const oversized = "x".repeat(5 * 1024 * 1024 + 1);
    completed(session);
    const stringify = vi.spyOn(JSON, "stringify");
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      session.captureCompletion(
        { ...body, input: [{ type: "input_image", image_url: oversized }] },
        {
          type: "response.completed",
          response: {
            id: "response-large",
            status: "completed",
            output: [],
          },
        },
      );
      expect(stringify).not.toHaveBeenCalled();
      expect(clone).not.toHaveBeenCalled();
      expect(
        session.prepareBody({
          ...body,
          input: [{ type: "input_image", image_url: oversized }],
        }).incremental,
      ).toBe(false);
    } finally {
      stringify.mockRestore();
      clone.mockRestore();
      session.dispose();
    }
  });

  it("keeps the exact replay limit for JSON escaping overhead", () => {
    const session = new ResponsesTransportSession();
    const escapedInput = [{ content: '"'.repeat(3 * 1024 * 1024) }];
    session.captureCompletion(
      { ...body, input: escapedInput },
      {
        type: "response.completed",
        response: { id: "escaped", status: "completed", output: [] },
      },
    );
    expect(
      session.prepareBody({ ...body, input: escapedInput }).incremental,
    ).toBe(false);
    session.dispose();
  });

  it("does not count object properties omitted by JSON", () => {
    const session = new ResponsesTransportSession();
    const omittedInput = [{ ["x".repeat(5 * 1024 * 1024)]: undefined }];
    session.captureCompletion(
      { ...body, input: omittedInput },
      {
        type: "response.completed",
        response: { id: "omitted", status: "completed", output: [] },
      },
    );
    expect(
      session.prepareBody({ ...body, input: omittedInput }).incremental,
    ).toBe(true);
    session.dispose();
  });

  it("measures the replay limit in JSON characters rather than UTF-8 bytes", () => {
    const session = new ResponsesTransportSession();
    const unicodeInput = [{ content: "😀".repeat(1_400_000) }];
    session.captureCompletion(
      { ...body, input: unicodeInput },
      {
        type: "response.completed",
        response: { id: "unicode", status: "completed", output: [] },
      },
    );
    expect(
      session.prepareBody({ ...body, input: unicodeInput }).incremental,
    ).toBe(true);
    session.dispose();
  });

  it("rejects oversized output without serializing it or retaining the previous chain", () => {
    const session = new ResponsesTransportSession();
    completed(session);
    const largeOutput = [{ text: "x".repeat(5 * 1024 * 1024 + 1) }];
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      session.captureCompletion(body, {
        type: "response.completed",
        response: {
          id: "large-output",
          status: "completed",
          output: largeOutput,
        },
      });
      expect(stringify).not.toHaveBeenCalled();
      expect(
        session.prepareBody({ ...body, input: [...input, ...output] })
          .incremental,
      ).toBe(false);
    } finally {
      stringify.mockRestore();
      session.dispose();
    }
  });

  it("invalidates history on reconnect and incomplete response", () => {
    const session = new ResponsesTransportSession();
    completed(session);
    session.invalidate();
    expect(
      session.prepareBody({ ...body, input: [...input, ...output] })
        .incremental,
    ).toBe(false);
    session.captureCompletion(body, {
      type: "response.incomplete",
      response: { id: "incomplete", output },
    });
    expect(
      session.prepareBody({ ...body, input: [...input, ...output] })
        .incremental,
    ).toBe(false);
    session.dispose();
  });
});

describe("ResponsesTransportPolicy", () => {
  it("suppresses only the failed identity after two failures and clears on policy toggle", () => {
    vi.useFakeTimers();
    try {
      const policy = new ResponsesTransportPolicy();
      policy.failure("owner-a");
      expect(policy.suppressed("owner-a")).toBe(false);
      policy.failure("owner-a");
      expect(policy.suppressed("owner-a")).toBe(true);
      expect(policy.suppressed("owner-b")).toBe(false);
      vi.advanceTimersByTime(5 * 60_000);
      expect(policy.suppressed("owner-a")).toBe(false);
      policy.failure("owner-a");
      policy.failure("owner-a");
      policy.observe(false);
      policy.observe(true);
      expect(policy.suppressed("owner-a")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
