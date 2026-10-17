import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssistantReleaseUpdateService,
  type AssistantReleaseUpdateServiceOptions,
} from "./assistantReleaseUpdateService.js";
import {
  GithubReleaseClient,
  ReleaseRateLimitError,
  type ReleaseDiscovery,
} from "./githubReleaseClient.js";
import type { ReleaseUpdateIdentity } from "./releaseUpdateTypes.js";

const DAY = 24 * 60 * 60_000;
const identity: ReleaseUpdateIdentity = {
  product: "assistant",
  version: "1.0.0",
  target: "linux-x64",
  development: false,
};
function record(version = "1.1.0", preview = false) {
  return {
    metadata: {
      schemaVersion: 1 as const,
      product: "assistant" as const,
      version,
      tag: `assistant-v${version}`,
      channel: preview ? ("preview" as const) : ("stable" as const),
      targets: {
        "linux-x64": "assistant-release.env",
        "linux-arm64": "assistant-release.env",
      },
      engines: {},
    },
    assets: ["assistant-release.env"],
    prerelease: preview,
    notes: `Notes for ${version}`,
  };
}
function githubRelease(version = "1.1.0", preview = false) {
  const tag = `assistant-v${version}`;
  return {
    tag_name: tag,
    draft: false,
    prerelease: preview,
    published_at: "2026-10-01T00:00:00Z",
    body: `Notes for ${version}`,
    assets: ["assistant-release.env", "agentlink-update.json"].map((name) => ({
      name,
      browser_download_url: `https://github.com/reefbarman/agentlink/releases/download/${tag}/${name}`,
    })),
  };
}
const directories: string[] = [];
const services: AssistantReleaseUpdateService[] = [];
afterEach(async () => {
  services.splice(0).forEach((service) => service.dispose());
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function create(
  options: Partial<AssistantReleaseUpdateServiceOptions> = {},
) {
  const storageDirectory =
    options.storageDirectory ??
    (await mkdtemp(path.join(tmpdir(), "assistant-update-")));
  if (!directories.includes(storageDirectory))
    directories.push(storageDirectory);
  const discover = vi.fn<GithubReleaseClient["discover"]>(async () => ({
    records: [record()],
    complete: true,
    unverifiedVersions: [],
  }));
  const service = new AssistantReleaseUpdateService({
    version: "1.0.0",
    target: "linux-x64",
    storageDirectory,
    automaticChecks: false,
    client: { discover },
    ...options,
  });
  services.push(service);
  await service.start();
  return { service, discover, storageDirectory };
}

describe("AssistantReleaseUpdateService", () => {
  it("exposes bounded release notes through shared discovery and persists them across versions", async () => {
    const first = await create();
    const state = await first.service.check();
    expect(state).toMatchObject({
      status: "available",
      automaticChecks: false,
      includePreviews: false,
      stale: false,
      releases: [
        { version: "1.1.0", channel: "stable", notes: "Notes for 1.1.0" },
      ],
    });
    const restored = await create({
      storageDirectory: first.storageDirectory,
      version: "1.1.0",
      target: "linux-x64",
    });
    expect(restored.service.snapshot()).toMatchObject({
      status: "current",
      releases: state.releases,
    });
    expect(restored.discover).not.toHaveBeenCalled();
  });

  it("persists failed checks without converting a previously available release into current", async () => {
    let now = Date.now();
    const first = await create({ now: () => now });
    await first.service.check();
    now += 5_001;
    first.discover.mockRejectedValueOnce(
      new Error("secret network diagnostic"),
    );
    expect(await first.service.check()).toMatchObject({
      status: "unavailable",
      stale: true,
      error: "release_check_failed",
      releases: [{ version: "1.1.0" }],
    });
    const restored = await create({
      storageDirectory: first.storageDirectory,
      now: () => now,
    });
    expect(restored.service.snapshot()).toMatchObject({
      status: "unavailable",
      stale: true,
      error: "release_check_failed",
      releases: [{ notes: "Notes for 1.1.0" }],
    });
    expect(
      await readFile(
        path.join(first.storageDirectory, "assistant-linux-x64-cache.json"),
        "utf8",
      ),
    ).not.toContain("secret network diagnostic");
  });

  it("restores rate-limit cooldown and refuses even manual network checks before retryAt", async () => {
    const now = Date.now();
    const first = await create({ now: () => now });
    first.discover.mockRejectedValueOnce(
      new ReleaseRateLimitError(now + 120_000),
    );
    await first.service.check();
    const restored = await create({
      storageDirectory: first.storageDirectory,
      now: () => now,
    });
    expect(await restored.service.check()).toMatchObject({
      status: "rate_limited",
      retryAt: now + 120_000,
      error: "release_rate_limited",
    });
    expect(restored.discover).not.toHaveBeenCalled();
  });

  it("shares daily automatic attempts, coalesces manual requests, and persists preferences", async () => {
    let now = Date.now();
    const first = await create({ now: () => now, automaticChecks: true });
    await Promise.all([first.service.check(false), first.service.check(false)]);
    await first.service.check(false);
    expect(first.discover).toHaveBeenCalledTimes(1);
    const restored = await create({
      storageDirectory: first.storageDirectory,
      now: () => now,
      automaticChecks: true,
    });
    await restored.service.check(false);
    expect(restored.discover).not.toHaveBeenCalled();
    now += DAY + 1;
    await restored.service.check(false);
    expect(restored.discover).toHaveBeenCalledTimes(1);
    await restored.service.setPreferences({
      automaticChecks: false,
      includePreviews: true,
    });
    const restarted = await create({
      storageDirectory: first.storageDirectory,
      automaticChecks: undefined,
      includePreviews: undefined,
    });
    expect(restarted.service.snapshot()).toMatchObject({
      automaticChecks: false,
      includePreviews: true,
    });
    expect(restarted.discover).not.toHaveBeenCalled();
  });

  it("filters previews by preference without changing the numeric version comparator", async () => {
    const discovery: ReleaseDiscovery = {
      records: [record("1.2.0", true), record()],
      complete: true,
      unverifiedVersions: [],
    };
    const first = await create({ client: { discover: async () => discovery } });
    expect(
      (await first.service.check()).releases.map((release) => release.version),
    ).toEqual(["1.1.0"]);
    await first.service.setPreferences({
      automaticChecks: false,
      includePreviews: true,
    });
    expect(
      first.service.snapshot().releases.map((release) => release.version),
    ).toEqual(["1.2.0", "1.1.0"]);
    await first.service.setPreferences({
      automaticChecks: false,
      includePreviews: false,
    });
    expect(
      first.service.snapshot().releases.map((release) => release.version),
    ).toEqual(["1.1.0"]);
  });

  it.each([{ version: "1.0.0-rc.1" }, { target: "darwin-arm64" }])(
    "rejects unsupported identities before accessing the network: %j",
    async (options) => {
      const first = await create(options);
      expect(first.service.snapshot().status).toBe("unsupported");
      expect((await first.service.check()).status).toBe("unsupported");
      expect(first.discover).not.toHaveBeenCalled();
    },
  );
});

describe("Assistant GitHub discovery", () => {
  it("requires verified metadata and the release env asset, ignores foreign and suffix tags, and defaults to stable", async () => {
    const releases = [
      githubRelease("1.4.0", true),
      githubRelease("1.3.0-rc.1", true),
      githubRelease("1.2.0"),
      githubRelease(),
    ];
    releases[2].assets = releases[2].assets.filter(
      (asset) => asset.name !== "assistant-release.env",
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      const version = /assistant-v([^/]+)\//.exec(url)?.[1];
      return Response.json(
        version
          ? record(version, version === "1.4.0").metadata
          : [
              ...releases,
              { ...githubRelease("9.0.0"), tag_name: "cli-v9.0.0" },
            ],
      );
    });
    const client = new GithubReleaseClient(fetch);
    const stable = await client.discover(
      identity,
      new AbortController().signal,
    );
    expect(stable.records.map((value) => value.metadata.version)).toEqual([
      "1.1.0",
    ]);
    expect(stable.unverifiedVersions).toContain("1.2.0");
    expect(
      fetch.mock.calls.some(([url]) => String(url).includes("-rc.1")),
    ).toBe(false);
    expect(
      fetch.mock.calls.some(([url]) =>
        String(url).endsWith("assistant-release.env"),
      ),
    ).toBe(false);
    const previews = await client.discover(
      { ...identity, includePreviews: true },
      new AbortController().signal,
    );
    expect(previews.records.map((value) => value.metadata.version)).toEqual([
      "1.4.0",
      "1.1.0",
    ]);
  });

  it("bounds history and notes, retaining older installed releases as well as the newest", async () => {
    const releases = Array.from({ length: 12 }, (_, index) => ({
      ...githubRelease(`1.${index}.0`),
      body: "文".repeat(40_000),
    }));
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const version = /assistant-v([^/]+)\//.exec(String(input))?.[1];
      return Response.json(version ? record(version).metadata : releases);
    });
    const client = new GithubReleaseClient(fetch);
    const discovery = await client.discover(
      identity,
      new AbortController().signal,
    );
    expect(discovery.records).toHaveLength(8);
    expect(discovery.records[0].metadata.version).toBe("1.11.0");
    expect(
      discovery.records.every((value) => value.notes?.length === 32_000),
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(9);
    const first = await create({ client: { discover: async () => discovery } });
    await first.service.check();
    const restored = await create({ storageDirectory: first.storageDirectory });
    expect(restored.service.snapshot().releases).toHaveLength(8);
    expect(restored.service.snapshot().releases[0].notes).toHaveLength(32_000);
  });

  it("uses conditional ETags for both the listing and metadata", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (new Headers(init?.headers).has("If-None-Match"))
        return new Response(null, { status: 304 });
      return Response.json(
        String(input).includes("/download/")
          ? record().metadata
          : [githubRelease()],
        { headers: { etag: '"release-v1"' } },
      );
    });
    const client = new GithubReleaseClient(fetch);
    await client.discover(identity, new AbortController().signal);
    const second = await client.discover(
      identity,
      new AbortController().signal,
    );
    expect(second.records).toHaveLength(1);
    expect(
      fetch.mock.calls
        .slice(2)
        .every(
          ([, init]) =>
            new Headers(init?.headers).get("If-None-Match") === '"release-v1"',
        ),
    ).toBe(true);
  });

  it("honours HTTP-date secondary rate limits", async () => {
    const now = Date.parse("2026-10-01T00:00:00Z");
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(null, {
          status: 403,
          headers: { "retry-after": "Thu, 01 Oct 2026 00:02:00 GMT" },
        }),
    );
    await expect(
      new GithubReleaseClient(fetch, () => now).discover(
        identity,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ retryAt: now + 120_000 });
  });

  it("applies the shared end-to-end timeout and sanitises timeout errors", async () => {
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(
        AbortSignal.abort(new DOMException("timed out", "TimeoutError")),
      );
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      init?.signal?.throwIfAborted();
      return Response.json([]);
    });
    const first = await create({ client: new GithubReleaseClient(fetch) });
    expect(await first.service.check()).toMatchObject({
      status: "unavailable",
      error: "release_check_timeout",
      stale: true,
    });
    expect(timeout).toHaveBeenCalledWith(20_000);
  });
});
