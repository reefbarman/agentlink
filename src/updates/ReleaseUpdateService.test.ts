import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReleaseUpdateService } from "./ReleaseUpdateService.js";
import {
  GithubReleaseClient,
  ReleaseRateLimitError,
  type ReleaseDiscovery,
} from "./githubReleaseClient.js";
import type { ReleaseUpdateIdentity } from "./releaseUpdateTypes.js";

const identity: ReleaseUpdateIdentity = {
  product: "cli",
  version: "0.3.0",
  target: "darwin-arm64",
  development: false,
};
const discovery: ReleaseDiscovery = {
  records: [
    {
      metadata: {
        schemaVersion: 1,
        product: "cli",
        version: "0.4.0",
        tag: "cli-v0.4.0",
        channel: "preview",
        targets: { "darwin-arm64": "agentlink-cli-darwin-arm64-v0.4.0.tar.gz" },
        engines: {},
      },
      assets: ["agentlink-cli-darwin-arm64-v0.4.0.tar.gz"],
      prerelease: true,
    },
  ],
  unverifiedVersions: [],
  complete: false,
};
const directories: string[] = [];
const services: ReleaseUpdateService[] = [];
afterEach(async () => {
  services.forEach((service) => service.dispose());
  services.length = 0;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function create(
  options: {
    development?: boolean;
    automaticChecks?: boolean;
    directory?: string;
    version?: string;
    now?: () => number;
    discover?: () => Promise<ReleaseDiscovery>;
  } = {},
) {
  const directory =
    options.directory ??
    (await mkdtemp(path.join(tmpdir(), "agentlink-update-")));
  if (!directories.includes(directory)) directories.push(directory);
  const discover = vi.fn<GithubReleaseClient["discover"]>(
    options.discover ?? (async () => discovery),
  );
  const service = new ReleaseUpdateService({
    identity: {
      ...identity,
      development: options.development ?? false,
      version: options.version ?? identity.version,
    },
    storageDirectory: directory,
    automaticChecks: options.automaticChecks ?? false,
    client: { discover },
    now: options.now,
  });
  services.push(service);
  await service.start();
  return { service, discover, directory };
}

describe("release update service", () => {
  it("loads cache without blocking on a network check and preserves dismissal", async () => {
    const { service, directory } = await create();
    expect(service.snapshot().status).toBe("idle");
    await service.check();
    expect(service.snapshot().candidate?.version).toBe("0.4.0");
    await service.dismiss();
    const restored = await create({ directory });
    expect(restored.service.snapshot().dismissedVersion).toBe("0.4.0");
    expect(restored.service.snapshot().candidate?.version).toBe("0.4.0");
    expect(restored.discover).not.toHaveBeenCalled();
  });
  it("coalesces manual checks and suppresses daily automatic attempts", async () => {
    let now = Date.now();
    const { service, discover } = await create({ now: () => now });
    await Promise.all([service.check(), service.check()]);
    expect(discover).toHaveBeenCalledTimes(1);
    await service.setAutomaticChecks(true);
    await service.check(false);
    expect(discover).toHaveBeenCalledTimes(1);
    now += 24 * 60 * 60_000 + 1;
    await service.check(false);
    expect(discover).toHaveBeenCalledTimes(2);
  });
  it("source runs and opt-out do not automatically access the network", async () => {
    const source = await create({ development: true, automaticChecks: true });
    await source.service.check(false);
    expect(source.discover).not.toHaveBeenCalled();
    await source.service.check();
    expect(source.discover).toHaveBeenCalledOnce();
  });
  it("recomputes shared cache facts against each process version", async () => {
    const newer = await create({ version: "0.4.0" });
    await newer.service.check();
    expect(newer.service.snapshot().candidate).toBeNull();
    const older = await create({ directory: newer.directory });
    expect(older.service.snapshot().candidate?.version).toBe("0.4.0");
  });
  it("shares a daily attempt across concurrent hosts using the refresh lease", async () => {
    const first = await create();
    const second = await create({ directory: first.directory });
    await Promise.all([
      first.service.setAutomaticChecks(true),
      second.service.setAutomaticChecks(true),
    ]);
    await Promise.all([
      first.service.check(false),
      second.service.check(false),
    ]);
    expect(
      first.discover.mock.calls.length + second.discover.mock.calls.length,
    ).toBe(1);
  });
  it("cancels automatic work on opt-out without leaving a checking indicator", async () => {
    let complete!: (value: ReleaseDiscovery) => void;
    const pending = new Promise<ReleaseDiscovery>((resolve) => {
      complete = resolve;
    });
    const { service, discover } = await create({ discover: () => pending });
    const checking = new Promise<void>((resolve) => {
      const unsubscribe = service.subscribe((state) => {
        if (state.status === "checking") {
          unsubscribe();
          resolve();
        }
      });
    });
    await service.setAutomaticChecks(true);
    await checking;
    const inFlight = service.check(false);
    await service.setAutomaticChecks(false);
    expect(discover.mock.calls[0][1].aborted).toBe(true);
    complete(discovery);
    await inFlight;
    expect(service.snapshot().automaticChecks).toBe(false);
    expect(service.snapshot().status).not.toBe("checking");
    expect(service.snapshot().candidate).toBeNull();
  });
  it("keeps network failure honest and persists rate-limit cooldown", async () => {
    const retryAt = Date.now() + 60_000;
    const first = await create({
      discover: async () => {
        throw new ReleaseRateLimitError(retryAt);
      },
    });
    await first.service.check();
    expect(first.service.snapshot()).toMatchObject({
      status: "rate_limited",
      stale: true,
      retryAt,
    });
    const next = await create({ directory: first.directory });
    await next.service.check();
    expect(next.discover).not.toHaveBeenCalled();
  });
});

describe("GitHub release metadata client", () => {
  it("checks only metadata and accepts independent preview streams", async () => {
    const tag = "cli-v0.4.0";
    const url = `https://github.com/reefbarman/agentlink/releases/download/${tag}/agentlink-update.json`;
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (input) =>
        new Response(
          JSON.stringify(
            String(input) === url
              ? discovery.records[0].metadata
              : [
                  {
                    tag_name: tag,
                    draft: false,
                    prerelease: true,
                    published_at: "2026-10-01T00:00:00Z",
                    assets: [
                      {
                        name: "agentlink-update.json",
                        browser_download_url: url,
                      },
                      {
                        name: discovery.records[0].assets[0],
                        browser_download_url: `https://github.com/reefbarman/agentlink/releases/download/${tag}/${discovery.records[0].assets[0]}`,
                      },
                    ],
                  },
                ],
          ),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const result = await new GithubReleaseClient(fetch).discover(
      identity,
      new AbortController().signal,
    );
    expect(result.records[0].metadata).toEqual(discovery.records[0].metadata);
    expect(result.records[0].assets).toContain(discovery.records[0].assets[0]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.every(([input]) => !String(input).endsWith(".tar.gz")),
    ).toBe(true);
  });
  it("keeps the newest compatible facts without fetching every older release", async () => {
    const releases = Array.from({ length: 6 }, (_, index) => {
      const version = `0.${6 - index}.0`;
      const tag = `cli-v${version}`;
      const assets = [
        "agentlink-update.json",
        `agentlink-cli-darwin-arm64-v${version}.tar.gz`,
      ];
      return {
        tag_name: tag,
        draft: false,
        prerelease: true,
        published_at: "2026-10-01",
        assets: assets.map((name) => ({
          name,
          browser_download_url: `https://github.com/reefbarman/agentlink/releases/download/${tag}/${name}`,
        })),
      };
    });
    const metadata = {
      ...discovery.records[0].metadata,
      version: "0.6.0",
      tag: "cli-v0.6.0",
      targets: { "darwin-arm64": releases[0].assets[1].name },
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/"))
        return Response.json(releases);
      if (url.startsWith("https://github.com/"))
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://release-assets.githubusercontent.com/metadata",
          },
        });
      return Response.json(metadata);
    });
    const result = await new GithubReleaseClient(fetch).discover(
      { ...identity, version: "0.6.0" },
      new AbortController().signal,
    );
    expect(result.complete).toBe(true);
    expect(result.records.map((record) => record.metadata.version)).toEqual([
      "0.6.0",
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("counts redirects within the ten-request total budget", async () => {
    let redirects = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      if (++redirects % 4 !== 0)
        return new Response(null, {
          status: 302,
          headers: {
            location:
              "https://api.github.com/repos/reefbarman/agentlink/releases?redirect=1",
          },
        });
      return Response.json(
        Array.from({ length: 100 }, () => ({
          tag_name: "v1.0.0",
          draft: false,
          prerelease: false,
          published_at: "2026-10-01",
          assets: [],
        })),
      );
    });
    await expect(
      new GithubReleaseClient(fetch).discover(
        identity,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ complete: false });
    expect(fetch).toHaveBeenCalledTimes(10);
  });
  it("rejects unexpected metadata redirect destinations", async () => {
    const tag = "cli-v0.4.0";
    const url = `https://github.com/reefbarman/agentlink/releases/download/${tag}/agentlink-update.json`;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input) === url
        ? new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/metadata" },
          })
        : new Response(
            JSON.stringify([
              {
                tag_name: tag,
                draft: false,
                prerelease: true,
                published_at: "2026-10-01",
                assets: [
                  { name: "agentlink-update.json", browser_download_url: url },
                ],
              },
            ]),
          ),
    );
    await expect(
      new GithubReleaseClient(fetch).discover(
        identity,
        new AbortController().signal,
      ),
    ).rejects.toThrow("invalid_release_url");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
