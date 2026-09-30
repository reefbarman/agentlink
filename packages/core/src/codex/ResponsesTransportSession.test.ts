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
