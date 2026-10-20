import type {
  PublicFetchRequest,
  PublicWebFetcher,
} from "./webImageTransport.js";
import { describe, expect, it, vi } from "vitest";

import { WebImageError } from "./webImageErrors.js";
import { createPublicWebPageFetcher } from "./webPageFetcher.js";

function fakeFetcher(response: {
  contentType?: string;
  body: string;
  finalUrl?: string;
  truncated?: boolean;
}): PublicWebFetcher & { requests: PublicFetchRequest[] } {
  const requests: PublicFetchRequest[] = [];
  const fetcher = vi.fn(async (request: PublicFetchRequest) => {
    requests.push(request);
    return {
      requestedUrl: request.url,
      finalUrl: new URL(response.finalUrl ?? request.url.href),
      status: 200,
      contentType: response.contentType,
      body: Buffer.from(response.body),
      ...(response.truncated ? { truncated: true } : {}),
    };
  });
  return Object.assign(fetcher, { requests });
}

describe("createPublicWebPageFetcher", () => {
  it("reads HTML as text through the public-only transport", async () => {
    const fetcher = fakeFetcher({
      contentType: "text/html; charset=utf-8",
      body: '<html><head><title>Hi &amp; bye</title></head><body><h1>Head</h1><p>See <a href="/x">this</a></p><script>bad()</script></body></html>',
      finalUrl: "https://example.com/final",
    });
    const pages = createPublicWebPageFetcher({ fetcher });
    const page = await pages.fetchPage({ url: " https://example.com/a#frag " });
    expect(fetcher.requests[0]!.url.href).toBe("https://example.com/a");
    expect(fetcher.requests[0]!.truncateAtLimit).toBe(true);
    expect(page).toMatchObject({
      url: "https://example.com/final",
      status: 200,
      contentType: "text/html",
      title: "Hi & bye",
      bodyTruncated: false,
    });
    expect(page.text).toContain("# Head");
    expect(page.text).toContain("this (https://example.com/x)");
    expect(page.text).not.toContain("bad()");
  });

  it("returns other text as is and reports truncation", async () => {
    const pages = createPublicWebPageFetcher({
      fetcher: fakeFetcher({
        contentType: "application/json",
        body: ' {"a":1} ',
        truncated: true,
      }),
    });
    const page = await pages.fetchPage({ url: "https://example.com/a.json" });
    expect(page.text).toBe('{"a":1}');
    expect(page.bodyTruncated).toBe(true);
  });

  it("refuses binary content and invalid URLs with safe errors", async () => {
    const pages = createPublicWebPageFetcher({
      fetcher: fakeFetcher({ contentType: "image/png", body: "png" }),
    });
    await expect(
      pages.fetchPage({ url: "https://example.com/a.png" }),
    ).rejects.toBeInstanceOf(WebImageError);
    await expect(pages.fetchPage({ url: "not a url" })).rejects.toThrow(
      "absolute http(s) URL",
    );
  });

  it("passes cancellation to the transport", async () => {
    const fetcher = fakeFetcher({ contentType: "text/plain", body: "x" });
    const controller = new AbortController();
    await createPublicWebPageFetcher({ fetcher }).fetchPage({
      url: "https://example.com/",
      signal: controller.signal,
    });
    expect(fetcher.requests[0]!.signal).toBe(controller.signal);
  });
});
