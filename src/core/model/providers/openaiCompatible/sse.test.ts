import { describe, expect, it } from "vitest";

import { parseOpenAiCompatibleSse } from "@agentlink/core/openai-compatible";

async function* chunks(
  values: Array<string | Uint8Array>,
): AsyncGenerator<string | Uint8Array> {
  yield* values;
}

async function collect(values: Array<string | Uint8Array>) {
  const result = [];
  for await (const frame of parseOpenAiCompatibleSse(chunks(values))) {
    result.push(frame);
  }
  return result;
}

describe("parseOpenAiCompatibleSse", () => {
  it("parses arbitrary UTF-8 byte boundaries, comments, and CRLF frames", async () => {
    const bytes = new TextEncoder().encode(
      ': heartbeat\r\nevent: message\r\nid: 7\r\ndata: {"text":"héllo"}\r\n\r\n',
    );

    expect(
      await collect([
        bytes.slice(0, 49),
        bytes.slice(49, 50),
        bytes.slice(50, 51),
        bytes.slice(51),
      ]),
    ).toEqual([
      {
        data: '{"text":"héllo"}',
        event: "message",
        id: "7",
      },
    ]);
  });

  it("joins multiline data and accepts mixed blank-line delimiters", async () => {
    expect(
      await collect([
        "data: {\n",
        'data: "ok":true}\r\n\nretry: 125\nid: ignored\n\n',
      ]),
    ).toEqual([{ data: '{\n"ok":true}' }]);
  });

  it("emits a clean final frame at EOF and ignores comment-only EOF", async () => {
    expect(await collect(['data: {"done":true}'])).toEqual([
      { data: '{"done":true}' },
    ]);
    expect(await collect([": final heartbeat"])).toEqual([]);
  });

  it("passes through [DONE] as an ordinary data frame", async () => {
    expect(await collect(["data: [DONE]\n\n"])).toEqual([{ data: "[DONE]" }]);
  });
});
