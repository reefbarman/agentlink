import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalMarkdownImageReader,
  resolveMarkdownImage,
  urlAppearsInConversation,
  type MarkdownImageResolverContext,
} from "./markdownImageResolver.js";

const COVER = "https://coverartarchive.org/release/1/front-500";
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000",
  "hex",
);

function context(
  overrides: Partial<MarkdownImageResolverContext> = {},
): MarkdownImageResolverContext {
  return {
    sessionId: "session-1",
    getSessionImages: () => [],
    getMessages: () => [],
    web: {
      runtime: {
        fetchForDisplay: vi.fn(async () => ({
          mimeType: "image/jpeg" as const,
          data: Buffer.from("cover"),
          attribution: { origin: "web_url" as const, imageUrl: COVER },
        })),
      },
      policy: { mode: "enabled", allowedDomains: [], blockedDomains: [] },
    },
    ...overrides,
  };
}

describe("resolveMarkdownImage", () => {
  it("loads a web image automatically when a tool result already contained its URL", async () => {
    const ctx = context({
      getMessages: () => [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "text", text: `{"image_url":"${COVER}"}` }],
            },
          ],
        },
      ],
    });
    const result = await resolveMarkdownImage({ src: COVER }, ctx);
    expect(result).toMatchObject({
      status: "ready",
      src: `data:image/jpeg;base64,${Buffer.from("cover").toString("base64")}`,
      attribution: { imageUrl: COVER },
    });
  });

  it("asks before loading a URL that only the assistant wrote", async () => {
    const ctx = context({
      getMessages: () => [
        { role: "assistant", content: [{ type: "text", text: COVER }] },
      ],
    });
    expect(await resolveMarkdownImage({ src: COVER }, ctx)).toEqual({
      status: "needs_confirmation",
      host: "coverartarchive.org",
    });
    expect(
      (await resolveMarkdownImage({ src: COVER, userConfirmed: true }, ctx))
        .status,
    ).toBe("ready");
  });

  it("always asks in prompt mode and never loads when disabled", async () => {
    const seen = [{ role: "user", content: COVER }];
    const prompt = context({ getMessages: () => seen });
    prompt.web!.policy = { ...prompt.web!.policy, mode: "prompt" };
    expect((await resolveMarkdownImage({ src: COVER }, prompt)).status).toBe(
      "needs_confirmation",
    );
    const disabled = context({ getMessages: () => seen });
    disabled.web!.policy = { ...disabled.web!.policy, mode: "disabled" };
    expect(
      (
        await resolveMarkdownImage(
          { src: COVER, userConfirmed: true },
          disabled,
        )
      ).status,
    ).toBe("unavailable");
  });

  it("serves session images and stored web images without a download", async () => {
    const ctx = context({
      getSessionImages: () => [
        {
          id: "image_3",
          name: "cover.jpg",
          mimeType: "image/jpeg",
          base64: "c3RvcmVk",
          messageIndex: 1,
          imageIndex: 0,
          attribution: { origin: "web_url", imageUrl: COVER },
        },
      ],
    });
    expect(await resolveMarkdownImage({ src: "image_3" }, ctx)).toMatchObject({
      status: "ready",
      src: "data:image/jpeg;base64,c3RvcmVk",
      name: "cover.jpg",
    });
    expect(await resolveMarkdownImage({ src: COVER }, ctx)).toMatchObject({
      status: "ready",
      src: "data:image/jpeg;base64,c3RvcmVk",
    });
    expect(ctx.web!.runtime.fetchForDisplay).not.toHaveBeenCalled();
    expect((await resolveMarkdownImage({ src: "image_9" }, ctx)).status).toBe(
      "unavailable",
    );
  });

  it("rejects unsupported sources", async () => {
    for (const src of ["javascript:alert(1)", "data:image/svg+xml;base64,AA"]) {
      expect((await resolveMarkdownImage({ src }, context())).status).toBe(
        "unavailable",
      );
    }
  });
});

describe("urlAppearsInConversation", () => {
  it("matches HTML-escaped URLs and ignores image bytes", () => {
    const url = "https://example.com/a.png?x=1&y=2";
    expect(
      urlAppearsInConversation(
        [
          {
            role: "user",
            content: '<img src="https://example.com/a.png?x=1&amp;y=2">',
          },
        ],
        [url],
      ),
    ).toBe(true);
    expect(
      urlAppearsInConversation(
        [{ role: "user", content: [{ type: "image", data: url }] }],
        [url],
      ),
    ).toBe(false);
  });
});

describe("createLocalMarkdownImageReader", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads images inside the roots and rejects other files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "md-image-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "shot.png"), PNG_BYTES);
    fs.writeFileSync(path.join(root, "fake.png"), "not an image");
    const read = createLocalMarkdownImageReader(() => [root]);
    await expect(read("shot.png")).resolves.toMatchObject({
      mimeType: "image/png",
      name: "shot.png",
    });
    await expect(read("fake.png")).rejects.toThrow("not a supported image");
    await expect(read("notes.txt")).rejects.toThrow("Only PNG");
    await expect(read("/etc/hosts.png")).rejects.toThrow();
  });
});
