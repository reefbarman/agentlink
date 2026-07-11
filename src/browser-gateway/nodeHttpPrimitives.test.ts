import { PassThrough, Readable } from "stream";
import { describe, expect, it } from "vitest";
import { readBoundedBody, readJsonBody } from "./nodeHttpPrimitives.js";

function requestBody(...chunks: string[]): import("http").IncomingMessage {
  const request = Readable.from(chunks) as import("http").IncomingMessage;
  request.headers = {};
  return request;
}

describe("readJsonBody", () => {
  it("returns an empty object for empty and whitespace-only bodies", async () => {
    await expect(readJsonBody(requestBody())).resolves.toEqual({});
    await expect(readJsonBody(requestBody("  \n"))).resolves.toEqual({});
  });

  it("parses JSON split across request chunks", async () => {
    await expect(readJsonBody(requestBody('{"ok":', "true}"))).resolves.toEqual(
      {
        ok: true,
      },
    );
  });

  it("classifies malformed and oversized input as invalid JSON", async () => {
    await expect(readJsonBody(requestBody("{"))).rejects.toThrow(
      "invalid_json",
    );
    await expect(readJsonBody(requestBody('"abcd"'), 4)).rejects.toThrow(
      "invalid_json",
    );
  });

  it("rejects an over-limit stream without waiting for EOF", async () => {
    const request = new PassThrough();
    const incoming = request as unknown as import("http").IncomingMessage;
    incoming.headers = {};
    const result = readBoundedBody(incoming, 4);

    request.write("abcde");

    await expect(result).rejects.toThrow("invalid_request_body");
    expect(request.readableEnded).toBe(false);
    request.end();
  });

  it("rejects an oversized content length before reading", async () => {
    const request = new PassThrough();
    const incoming = request as unknown as import("http").IncomingMessage;
    incoming.headers = { "content-length": "5" };

    await expect(readBoundedBody(incoming, 4)).rejects.toThrow(
      "invalid_request_body",
    );
    request.end();
  });

  it("handles an error emitted while draining an oversized request", async () => {
    const request = new PassThrough();
    const incoming = request as unknown as import("http").IncomingMessage;
    incoming.headers = {};
    const result = readBoundedBody(incoming, 4);

    request.write("abcde");
    await expect(result).rejects.toThrow("invalid_request_body");
    expect(() =>
      request.emit("error", new Error("drain failed")),
    ).not.toThrow();
    request.end();
  });

  it("handles an error emitted after an aborted request", async () => {
    const request = new PassThrough();
    const incoming = request as unknown as import("http").IncomingMessage;
    incoming.headers = {};
    const result = readBoundedBody(incoming, 4);

    request.emit("aborted");
    await expect(result).rejects.toThrow("invalid_request_body");
    expect(() =>
      request.emit("error", new Error("socket closed")),
    ).not.toThrow();
    request.end();
  });
});
