import { describe, expect, it, vi } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import type { LookupFunction } from "node:net";
import { gzipSync } from "node:zlib";
import {
  isPublicAddress,
  createPublicOnlyLookup,
} from "./webImagePublicAddress.js";
import {
  assertPublicHttpUrl,
  createPublicWebFetcher,
  type PublicFetchRequest,
  type PublicWebFetcher,
} from "./webImageTransport.js";
import { sniffStaticImage } from "./webImageFormat.js";
import { extractPageImages } from "./webImagePageParser.js";
import { publishUrl } from "./webImageUrlPublication.js";
import { WebImageError } from "./webImageErrors.js";
import {
  WebImageToolRuntime,
  type WebImageApprovalRequest,
  type WebImagePolicy,
} from "./webImageRuntime.js";

function png(width: number, height: number, extraChunk?: string): Buffer {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([
      length,
      Buffer.from(type, "latin1"),
      data,
      Buffer.alloc(4),
    ]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    ...(extraChunk ? [chunk(extraChunk, Buffer.alloc(8))] : []),
    chunk("IDAT", Buffer.alloc(4)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function jpeg(width: number, height: number): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),
    sof,
    Buffer.alloc(16),
  ]);
}

describe("public address classification", () => {
  it("blocks private, local, transition and reserved ranges", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.1.2.3",
      "198.18.0.1",
      "224.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:8.8.8.8",
      "64:ff9b::808:808",
      "2002:c0a8:101::1",
      "2001:0:4136:e378::1",
      "fd00::1",
      "fe80::1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("rejects mixed public/private DNS answers at connection time", async () => {
    const mixed = ((_host, _options, callback) => {
      (
        callback as (
          e: null,
          a: Array<{ address: string; family: number }>,
        ) => void
      )(null, [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]);
    }) as LookupFunction;
    const lookup = createPublicOnlyLookup(mixed);
    const error = await new Promise<Error | null>((resolve) =>
      lookup("rebind.example.com", { all: true }, (err) => resolve(err)),
    );
    expect(error?.message).toBe("web_image_destination_not_public");
  });

  it("rejects literal IPs, local hosts, credentials and custom ports before connecting", () => {
    for (const url of [
      "http://127.0.0.1/a.png",
      "https://[::1]/a.png",
      "https://localhost/a.png",
      "https://printer.local/a.png",
      "https://intranet/a.png",
      "https://user:pass@example.com/a.png",
      "https://example.com:8443/a.png",
      "file:///etc/passwd",
    ]) {
      expect(() => assertPublicHttpUrl(new URL(url)), url).toThrow(
        WebImageError,
      );
    }
    expect(() =>
      assertPublicHttpUrl(new URL("https://example.com/a.png")),
    ).not.toThrow();
  });
});

describe("public web fetcher", () => {
  const allow = async () => undefined;
  const baseRequest = (url: string): PublicFetchRequest => ({
    url: new URL(url),
    accept: "*/*",
    maxBytes: 1024,
    maxRedirects: 3,
    deadlineMs: 5_000,
    authorize: allow,
  });

  it("fails closed when a proxy is configured instead of bypassing it", async () => {
    const fetcher = createPublicWebFetcher({
      env: { HTTPS_PROXY: "http://proxy:8080" },
    });
    await expect(
      fetcher(baseRequest("https://example.com/")),
    ).rejects.toMatchObject({
      code: "image_retrieval_proxy_unsupported",
    });
    await fetcher.dispose();
  });

  it("does not use the process-global dispatcher", async () => {
    const previous = getGlobalDispatcher();
    const hostile = new MockAgent();
    hostile.disableNetConnect();
    hostile
      .get("https://hostile.example.com")
      .intercept({ path: "/" })
      .reply(200, "served by the global dispatcher");
    setGlobalDispatcher(hostile);
    const lookups: string[] = [];
    const privateLookup = ((host, _options, callback) => {
      lookups.push(String(host));
      (
        callback as (
          e: null,
          a: Array<{ address: string; family: number }>,
        ) => void
      )(null, [{ address: "127.0.0.1", family: 4 }]);
    }) as LookupFunction;
    const fetcher = createPublicWebFetcher({ env: {}, lookup: privateLookup });
    try {
      await expect(
        fetcher(baseRequest("https://hostile.example.com/")),
      ).rejects.toMatchObject({
        code: "blocked_destination",
      });
      expect(lookups).toEqual(["hostile.example.com"]);
    } finally {
      setGlobalDispatcher(previous);
      await fetcher.dispose();
      await hostile.close();
    }
  });

  it("checks every redirect hop, rejects downgrades and enforces byte caps", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get("https://cdn.example.com");
    pool
      .intercept({ path: "/a" })
      .reply(302, "", { headers: { location: "/b" } });
    pool.intercept({ path: "/b" }).reply(200, "x".repeat(10));
    pool.intercept({ path: "/down" }).reply(302, "", {
      headers: { location: "http://cdn.example.com/plain" },
    });
    pool.intercept({ path: "/big" }).reply(200, "y".repeat(2048));
    pool.intercept({ path: "/private" }).reply(302, "", {
      headers: { location: "http://169.254.169.254/latest" },
    });
    const fetcher = createPublicWebFetcher({ env: {}, dispatcher: agent });
    const hops: string[] = [];
    const result = await fetcher({
      ...baseRequest("https://cdn.example.com/a"),
      authorize: async (url) => {
        hops.push(url.pathname);
      },
    });
    expect(hops).toEqual(["/a", "/b"]);
    expect(result.finalUrl.pathname).toBe("/b");
    await expect(
      fetcher(baseRequest("https://cdn.example.com/down")),
    ).rejects.toMatchObject({
      code: "blocked_destination",
    });
    await expect(
      fetcher(baseRequest("https://cdn.example.com/big")),
    ).rejects.toMatchObject({
      code: "byte_limit",
    });
    await expect(
      fetcher(baseRequest("https://cdn.example.com/private")),
    ).rejects.toMatchObject({
      code: "blocked_destination",
    });
    await agent.close();
  });

  it("keeps a decoded prefix of oversized compressed pages when truncation is allowed", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const html = `<head><meta property="og:image" content="/cover.jpg"></head>${"z".repeat(8192)}`;
    const gzipped = gzipSync(Buffer.from(html));
    const pool = agent.get("https://pages.example.com");
    for (let i = 0; i < 2; i++) {
      pool.intercept({ path: "/album" }).reply(200, gzipped, {
        headers: { "content-encoding": "gzip", "content-type": "text/html" },
      });
    }
    const fetcher = createPublicWebFetcher({ env: {}, dispatcher: agent });
    await expect(
      fetcher(baseRequest("https://pages.example.com/album")),
    ).rejects.toMatchObject({ code: "byte_limit" });
    const result = await fetcher({
      ...baseRequest("https://pages.example.com/album"),
      truncateAtLimit: true,
    });
    expect(result.truncated).toBe(true);
    expect(result.body.byteLength).toBe(1024);
    expect(result.body.toString()).toContain("og:image");
    await agent.close();
  });
});

describe("image format sniffing", () => {
  it("measures static PNG and JPEG images", () => {
    expect(sniffStaticImage(png(640, 480))).toEqual({
      mimeType: "image/png",
      width: 640,
      height: 480,
    });
    expect(sniffStaticImage(jpeg(1200, 900))).toEqual({
      mimeType: "image/jpeg",
      width: 1200,
      height: 900,
    });
  });

  it("rejects animation, oversized images and non-image bytes", () => {
    expect(() => sniffStaticImage(png(10, 10, "acTL"))).toThrow(
      /Animated PNG/u,
    );
    expect(() => sniffStaticImage(png(9000, 10))).toThrow(/limits/u);
    expect(() => sniffStaticImage(Buffer.from("<svg></svg>"))).toThrow(
      /HTML or SVG/u,
    );
    expect(() => sniffStaticImage(Buffer.from("GIF89a...."))).toThrow(/GIF/u);
  });
});

describe("page image extraction", () => {
  it("prefers structured metadata, resolves relative URLs and dedupes", async () => {
    const html = `<!doctype html><html><head>
      <title>Blue Album - Example Records</title>
      <base href="https://shop.example.com/assets/">
      <meta property="og:image" content="covers/blue.jpg">
      <meta property="og:image:alt" content="Blue album cover">
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"MusicAlbum","name":"Blue","byArtist":{"name":"The Band"},"image":"https://img.example.com/blue-full.jpg"}</script>
      <script type="application/ld+json">{ broken json</script>
      <script>document.write('<img src="https://evil.example.com/x.png">')</script>
      </head><body>
      <img src="covers/blue.jpg" alt="duplicate">
      <img src="icon.svg"><img src="tiny.png" width="16" height="16">
      <picture><source srcset="art-800.webp 800w, art-1600.webp 1600w, art-4000.webp 4000w"><img src="art.jpg" alt="Artwork"></picture>
      </body></html>`;
    const result = await extractPageImages(
      html,
      new URL("https://shop.example.com/albums/blue"),
      10,
    );
    expect(result.title).toBe("Blue Album - Example Records");
    expect(result.candidates.map((c) => [c.extraction, c.url])).toEqual([
      ["json_ld", "https://img.example.com/blue-full.jpg"],
      ["open_graph", "https://shop.example.com/assets/covers/blue.jpg"],
      ["html_image", "https://shop.example.com/assets/art-1600.webp"],
      ["html_image", "https://shop.example.com/assets/art.jpg"],
    ]);
    expect(result.candidates[0]).toMatchObject({
      creator: "The Band",
      title: "Blue",
    });
    expect(result.warnings).toContain(
      "Skipped a malformed or oversized JSON-LD block.",
    );
  });
});

describe("page image extraction (publisher logos)", () => {
  it("ignores JSON-LD publisher and organization logos", async () => {
    const html = `<html><head>
      <script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Article",
        name: "OK Computer",
        publisher: {
          "@type": "Organization",
          logo: {
            "@type": "ImageObject",
            url: "https://www.wikimedia.org/static/images/wmf-logo.png",
          },
        },
      })}</script>
      <meta property="og:image" content="https://upload.example.org/cover.png">
      </head><body></body></html>`;
    const result = await extractPageImages(
      html,
      new URL("https://en.example.org/wiki/OK_Computer"),
      10,
    );
    expect(result.candidates.map((candidate) => candidate.url)).toEqual([
      "https://upload.example.org/cover.png",
    ]);
  });
});

describe("direct image attribution", () => {
  it("credits the requested URL rather than the redirect target", async () => {
    const fetcher: PublicWebFetcher = async (req) => {
      await req.authorize(req.url, 0);
      return {
        requestedUrl: req.url,
        finalUrl: new URL("https://storage.example.net/blob/cover.png"),
        status: 200,
        contentType: "image/png",
        body: png(300, 300),
      };
    };
    const runtime = new WebImageToolRuntime({ fetcher });
    const result = await runtime.fetchForModel(
      { url: "https://coverart.example.org/release/1/front.png" },
      {
        sessionId: "redirect",
        policy: { mode: "enabled", allowedDomains: [], blockedDomains: [] },
      },
    );
    const image = result.content.find((item) => item.type === "image");
    expect(
      image?.type === "image" ? image.attribution : undefined,
    ).toMatchObject({
      origin: "web_url",
      imageUrl: "https://coverart.example.org/release/1/front.png",
    });
  });
});

describe("display retrieval", () => {
  const policy = {
    mode: "enabled" as const,
    allowedDomains: [],
    blockedDomains: ["blocked.example.com"],
  };

  it("caches display images and applies domain lists", async () => {
    let calls = 0;
    const fetcher: PublicWebFetcher = async (req) => {
      calls++;
      await req.authorize(req.url, 0);
      return {
        requestedUrl: req.url,
        finalUrl: req.url,
        status: 200,
        contentType: "image/png",
        body: png(40, 40),
      };
    };
    const runtime = new WebImageToolRuntime({ fetcher });
    const first = await runtime.fetchForDisplay(
      "https://img.example.com/cover.png",
      { sessionId: "d1", policy },
    );
    const second = await runtime.fetchForDisplay(
      "https://img.example.com/cover.png",
      { sessionId: "d2", policy },
    );
    expect(second).toBe(first);
    expect(calls).toBe(1);
    expect(first.attribution).toMatchObject({
      origin: "web_url",
      imageUrl: "https://img.example.com/cover.png",
    });
    await expect(
      runtime.fetchForDisplay("https://blocked.example.com/a.png", {
        sessionId: "d1",
        policy,
      }),
    ).rejects.toThrow("blocked");
    await expect(
      runtime.fetchForDisplay("https://img.example.com/other.png", {
        sessionId: "d1",
        policy: { ...policy, mode: "disabled" },
      }),
    ).rejects.toThrow("disabled");
  });
});

describe("URL publication", () => {
  it("strips queries, fragments, credentials and token-like paths", () => {
    expect(publishUrl("https://cdn.example.com/a.jpg?sig=secret#x")).toEqual({
      url: "https://cdn.example.com/a.jpg",
      sanitized: true,
    });
    expect(
      publishUrl(`https://cdn.example.com/${"A".repeat(64)}/a.jpg`),
    ).toEqual({ url: "https://cdn.example.com/", sanitized: true });
    expect(publishUrl("https://u:p@example.com/").url).toBeUndefined();
  });
});

describe("WebImageToolRuntime", () => {
  const promptPolicy: WebImagePolicy = {
    mode: "prompt",
    allowedDomains: [],
    blockedDomains: [],
  };

  function fakeFetcher(
    responses: Record<string, { body: Buffer; contentType: string }>,
  ) {
    const calls: string[] = [];
    const fetcher: PublicWebFetcher = async (req) => {
      await req.authorize(req.url, 0);
      calls.push(req.url.href);
      const response = responses[req.url.href];
      if (!response) throw new WebImageError("fetch_failed", "not found");
      return {
        requestedUrl: req.url,
        finalUrl: req.url,
        status: 200,
        contentType: response.contentType,
        body: response.body,
      };
    };
    return { fetcher, calls };
  }

  const page = `<html><head><title>Coat</title>
    <meta property="og:image" content="https://cdn.example.com/coat.png?sig=SECRET123">
    <script type="application/ld+json">{"@type":"Product","name":"Wool coat","image":{"@type":"ImageObject","contentUrl":"https://cdn.example.com/coat.png?sig=SECRET123","license":"CC BY 4.0"}}</script>
    </head></html>`;

  it("inspects, fetches by candidate and keeps signed URLs out of results", async () => {
    const { fetcher, calls } = fakeFetcher({
      "https://shop.example.com/coat?ref=ad": {
        body: Buffer.from(page),
        contentType: "text/html; charset=utf-8",
      },
      "https://cdn.example.com/coat.png?sig=SECRET123": {
        body: png(800, 600),
        contentType: "image/png",
      },
    });
    const runtime = new WebImageToolRuntime({ fetcher, now: () => 0 });
    const requestApproval = vi.fn(
      async (_request: WebImageApprovalRequest) => ({
        decision: "accept-chat",
      }),
    );
    const ctx = { sessionId: "s1", policy: promptPolicy, requestApproval };
    const inspected = await runtime.execute(
      "inspect_page_images",
      { url: "https://shop.example.com/coat?ref=ad" },
      ctx,
    );
    const inspectText = (inspected.content[0] as { text: string }).text;
    expect(inspected.isError).not.toBe(true);
    expect(inspectText).not.toContain("SECRET123");
    const payload = JSON.parse(inspectText) as {
      candidates: Array<{ candidate_id: string; license?: string }>;
      page: { url: string };
    };
    expect(payload.page.url).toBe("https://shop.example.com/coat");
    expect(payload.candidates).toHaveLength(1);
    expect(payload.candidates[0]?.license).toBe("CC BY 4.0");

    const fetched = await runtime.fetchForModel(
      { candidate_id: payload.candidates[0]!.candidate_id },
      ctx,
    );
    expect(JSON.stringify(fetched)).not.toContain("SECRET123");
    expect(fetched.content[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      attribution: {
        origin: "web_page",
        sourceUrl: "https://shop.example.com/coat",
        imageUrl: "https://cdn.example.com/coat.png",
        title: "Wool coat",
        license: "CC BY 4.0",
        width: 800,
        height: 600,
      },
    });
    // Chat-wide grant: one approval card for two different origins.
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
  });

  it("makes no connection after denial and honours blocked domains", async () => {
    const { fetcher, calls } = fakeFetcher({});
    const runtime = new WebImageToolRuntime({ fetcher });
    const denied = await runtime.fetchForModel(
      { url: "https://art.example.com/a.png" },
      {
        sessionId: "s2",
        policy: promptPolicy,
        requestApproval: async () => ({ decision: "reject" }),
      },
    );
    expect(denied.isError).toBe(true);
    expect((denied.content[0] as { text: string }).text).toContain(
      "approval_rejected",
    );
    const blocked = await runtime.fetchForModel(
      { url: "https://art.example.com/a.png" },
      {
        sessionId: "s2",
        policy: {
          mode: "enabled",
          allowedDomains: [],
          blockedDomains: ["example.com"],
        },
      },
    );
    expect((blocked.content[0] as { text: string }).text).toContain(
      "blocked_domain",
    );
    expect(calls).toEqual([]);
  });

  it("labels direct URLs honestly and rejects disabled policy and unknown candidates", async () => {
    const { fetcher } = fakeFetcher({
      "https://img.example.com/cover.jpg": {
        body: jpeg(500, 500),
        contentType: "image/jpeg",
      },
    });
    const runtime = new WebImageToolRuntime({ fetcher });
    const enabled = {
      sessionId: "s3",
      policy: { ...promptPolicy, mode: "enabled" as const },
    };
    const direct = await runtime.fetchForModel(
      { url: "https://img.example.com/cover.jpg" },
      enabled,
    );
    expect(direct.content[1]).toMatchObject({
      attribution: {
        origin: "web_url",
        extraction: "direct_url",
        imageUrl: "https://img.example.com/cover.jpg",
      },
    });
    expect(
      (direct.content[1] as unknown as { attribution: Record<string, unknown> })
        .attribution.sourceUrl,
    ).toBeUndefined();
    const unknown = await runtime.fetchForModel(
      { candidate_id: "img_missing" },
      enabled,
    );
    expect((unknown.content[0] as { text: string }).text).toContain(
      "candidate_unavailable",
    );
    const disabled = await runtime.fetchForModel(
      { url: "https://img.example.com/cover.jpg" },
      { sessionId: "s3", policy: { ...promptPolicy, mode: "disabled" } },
    );
    expect((disabled.content[0] as { text: string }).text).toContain(
      '"status":"disabled"',
    );
  });

  it("enforces per-turn fetch budgets and resets them on a new turn", async () => {
    const { fetcher } = fakeFetcher({
      "https://img.example.com/a.png": {
        body: png(100, 100),
        contentType: "image/png",
      },
    });
    const runtime = new WebImageToolRuntime({ fetcher });
    const ctx = (turnId: string) => ({
      sessionId: "s4",
      turnId,
      policy: { ...promptPolicy, mode: "enabled" as const },
    });
    for (let index = 0; index < 8; index++) {
      const result = await runtime.fetchForModel(
        { url: "https://img.example.com/a.png" },
        ctx("t1"),
      );
      expect(result.isError).not.toBe(true);
    }
    const over = await runtime.fetchForModel(
      { url: "https://img.example.com/a.png" },
      ctx("t1"),
    );
    expect((over.content[0] as { text: string }).text).toContain(
      "turn_budget_exceeded",
    );
    const next = await runtime.fetchForModel(
      { url: "https://img.example.com/a.png" },
      ctx("t2"),
    );
    expect(next.isError).not.toBe(true);
  });
});
