import {
  buildCodexEndpointRequestBody,
  translateCodexMessages,
} from "@agentlink/core/codex";
import { describe, expect, it } from "vitest";
import { getEndpointCaps, usesCodexResponsesLite } from "@agentlink/core/codex";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CoreModelMessage } from "@agentlink/core/model-runtime";
import { PNG } from "pngjs";
import { createHash } from "node:crypto";
import { normalizeMcpToolResult } from "./mcpToolResult.js";
import { toolResultToContent } from "./AgentEngine.js";

// Synthetic in-memory fixtures, never a desktop capture or provider request.
const pngImage = new PNG({ width: 2, height: 1 });
pngImage.data = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]);
const png = PNG.sync.write(pngImage);
const jpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
  "base64",
);
const fixtures = [
  { bytes: png, mimeType: "image/png", width: 2, height: 1 },
  { bytes: jpeg, mimeType: "image/jpeg", width: 1, height: 1 },
];
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

function toolTurn(callId: string, name: string, raw: CallToolResult) {
  const normalized = normalizeMcpToolResult(raw);
  const content = toolResultToContent(normalized, callId, name);
  const messages: CoreModelMessage[] = [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: callId, name, input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: callId, content }],
    },
  ];
  return { normalized, messages };
}

function request(messages: CoreModelMessage[], method: "oauth" | "apiKey") {
  const model = "gpt-6-astra";
  const input = translateCodexMessages(messages);
  const lite = usesCodexResponsesLite(model, method);
  const body = buildCodexEndpointRequestBody({
    model,
    input,
    instructions: "Screenshot composition audit",
    caps: getEndpointCaps({ method }),
    useResponsesLite: lite,
  });
  return { input, lite, wire: JSON.parse(JSON.stringify(body)) };
}

describe("Codex screenshot composition audit (no live capture or transport)", () => {
  it.each(["oauth", "apiKey"] as const)(
    "preserves standalone and post-action captures through the %s request body",
    (method) => {
      const messages: CoreModelMessage[] = [];
      const captures = fixtures.map((fixture, index) => {
        const callId = `capture_${index + 1}`;
        const bounds = {
          x: -20 + index,
          y: 10,
          width: fixture.width,
          height: 1,
        };
        const capture = {
          captureId: `00000000-0000-4000-8000-00000000000${index + 1}`,
          byteLength: fixture.bytes.length,
          target: { kind: "region", bounds },
          mimeType: fixture.mimeType,
          nativePixelSize: { width: fixture.width, height: fixture.height },
          outputPixelSize: { width: fixture.width, height: fixture.height },
          mapping: {
            kind: "linear",
            imageContentBounds: { x: 0, y: 0, width: fixture.width, height: 1 },
            screenBounds: bounds,
            pixelsPerPoint: { x: 1, y: 1 },
          },
          sha256: sha256(fixture.bytes),
          capturedAt: `2026-09-08T00:00:0${index}.000Z`,
        };
        const envelope =
          index === 0
            ? { capture }
            : {
                interaction: { position: { x: -19, y: 10 }, heldButtons: [] },
                capture,
              };
        const text = JSON.stringify(envelope, null, 2);
        const data = fixture.bytes.toString("base64");
        const { normalized, messages: turn } = toolTurn(
          callId,
          index === 0
            ? "computer_use__screen_capture"
            : "computer_use__mouse_click",
          {
            structuredContent: envelope,
            _meta: { auditPrivate: callId },
            content: [
              { type: "text", text },
              {
                type: "image",
                mimeType: fixture.mimeType,
                data,
                _meta: { "codex/imageDetail": "original" },
              },
            ],
          },
        );
        expect(normalized.data).toEqual(envelope);
        expect(normalized.mcpMeta).toMatchObject({
          resultMeta: { auditPrivate: callId },
          content: [
            { type: "text" },
            { type: "image", meta: { "codex/imageDetail": "original" } },
          ],
        });
        messages.push(...turn);
        return { callId, capture, text, data, fixture };
      });
      const { input, lite, wire } = request(messages, method);
      expect(lite).toBe(method === "oauth");
      expect(input).toHaveLength(6);
      const items = wire.input.slice(-6);
      captures.forEach(({ callId, capture, text, data, fixture }, index) => {
        const offset = index * 3;
        expect(items[offset]).toMatchObject({
          type: "function_call",
          call_id: callId,
        });
        expect(items[offset + 1]).toMatchObject({
          type: "function_call_output",
          call_id: callId,
        });
        expect(items[offset + 1].output).toContain(text);
        const image = {
          type: "input_image",
          image_url: `data:${fixture.mimeType};base64,${data}`,
        };
        expect(items[offset + 2]).toEqual({
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Media output of tool call ${callId}:`,
            },
            lite ? image : { ...image, detail: "auto" },
          ],
        });
        const received = Buffer.from(
          items[offset + 2].content[1].image_url.split(",")[1],
          "base64",
        );
        expect(received).toEqual(fixture.bytes);
        expect(sha256(received)).toBe(capture.sha256);
        expect(received.length).toBe(capture.byteLength);
        if (fixture.mimeType === "image/png") {
          const decoded = PNG.sync.read(received);
          expect({ width: decoded.width, height: decoded.height }).toEqual(
            capture.outputPixelSize,
          );
        } else {
          // JPEG coverage is byte preservation, not decoding or model acceptance.
          expect(received.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
          expect(received.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
        }
      });
      expect(JSON.stringify(wire)).not.toContain("auditPrivate");
      expect(JSON.stringify(wire)).not.toContain("codex/imageDetail");
    },
  );

  it("keeps a successful interaction with captureError text-only", () => {
    const result = {
      interaction: { position: { x: 10, y: 20 }, heldButtons: [] },
      captureError: {
        code: "target_not_found",
        message: "Capture target is unavailable",
      },
    };
    const text = JSON.stringify(result);
    const { normalized, messages } = toolTurn(
      "action_3",
      "computer_use__mouse_click",
      {
        structuredContent: result,
        content: [{ type: "text", text }],
      },
    );
    expect(normalized.isError).not.toBe(true);
    expect(normalized.data).toEqual(result);
    for (const method of ["oauth", "apiKey"] as const) {
      const { input, wire } = request(messages, method);
      expect(input).toHaveLength(2);
      expect(wire.input.slice(-2)).toEqual(input);
      expect(input[1]).toEqual({
        type: "function_call_output",
        call_id: "action_3",
        output: text,
      });
      expect(JSON.stringify(wire)).not.toContain("input_image");
      expect(JSON.stringify(wire)).not.toContain("Media attached");
    }
  });
});
