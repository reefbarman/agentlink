import type {
  ReleaseUpdateCandidate,
  ReleaseUpdateIdentity,
} from "./releaseUpdateTypes.js";
import { acquireInstallLock, downloadReleaseUpdate } from "./releaseInstall.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function temporary() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "release-install-"));
  directories.push(dir);
  return dir;
}
const identity: ReleaseUpdateIdentity = {
  product: "cli",
  version: "0.1.0",
  target: "darwin-arm64",
  development: false,
};
const candidate: ReleaseUpdateCandidate = {
  version: "0.2.0",
  tag: "cli-v0.2.0",
  target: identity.target,
  channel: "preview",
  releaseUrl: "",
  instructionsUrl: "",
};
const name = "agentlink-cli-darwin-arm64-v0.2.0.tar.gz";
const bytes = Buffer.from("verified artifact");
const digest = createHash("sha256").update(bytes).digest("hex");
function fixture(
  options: {
    checksum?: string;
    apiDigest?: string;
    omitSums?: boolean;
    incompatible?: boolean;
    draft?: boolean;
    redirect?: string;
    oversize?: boolean;
  } = {},
) {
  const base =
    "https://github.com/reefbarman/agentlink/releases/download/cli-v0.2.0/";
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes("api.github.com"))
      return Response.json({
        tag_name: candidate.tag,
        draft: options.draft ?? false,
        prerelease: true,
        published_at: "2026-01-01",
        assets: [
          name,
          "agentlink-update.json",
          ...(!options.omitSums ? ["SHA256SUMS"] : []),
        ].map((file) => ({
          name: file,
          browser_download_url: base + file,
          ...(file === name && options.apiDigest
            ? { digest: options.apiDigest }
            : {}),
        })),
      });
    if (url.endsWith("agentlink-update.json"))
      return Response.json({
        schemaVersion: 1,
        product: "cli",
        version: candidate.version,
        tag: candidate.tag,
        channel: "preview",
        targets: options.incompatible ? {} : { "darwin-arm64": name },
        engines: {},
      });
    if (url.endsWith("SHA256SUMS"))
      return new Response(`${options.checksum ?? digest}  ${name}\n`);
    if (options.redirect)
      return new Response(null, {
        status: 302,
        headers: { location: options.redirect },
      });
    return new Response(bytes, {
      headers: options.oversize
        ? { "content-length": String(400 * 1024 * 1024) }
        : {},
    });
  });
}
describe("verified release download", () => {
  it("resolves fresh metadata and verifies checksums before activating the file", async () => {
    const directory = await temporary();
    const request = fixture({ apiDigest: `sha256:${digest}` });
    const result = await downloadReleaseUpdate(identity, candidate, {
      directory,
      request,
    });
    expect(await readFile(result)).toEqual(bytes);
    expect(await readdir(directory)).toEqual([name]);
    expect(request).toHaveBeenCalledTimes(4);
  });
  it.each([
    [{ checksum: "a".repeat(64) }, "checksum mismatch"],
    [{ apiDigest: `sha256:${"b".repeat(64)}` }, "digest"],
    [{ omitSums: true }, "SHA256SUMS"],
    [{ incompatible: true }, "compatible"],
    [{ draft: true }, "published"],
    [{ redirect: "https://attacker.invalid/file" }, "URL"],
    [{ oversize: true }, "too large"],
  ] as const)("refuses invalid artifacts: %j", async (options, message) => {
    const directory = await temporary();
    await expect(
      downloadReleaseUpdate(identity, candidate, {
        directory,
        request: fixture(options),
      }),
    ).rejects.toThrow(message);
    expect(await readdir(directory)).toEqual([]);
  });
  it("cleans up after a interrupted body", async () => {
    const directory = await temporary();
    const normal = fixture();
    const request = vi.fn<typeof fetch>(async (...args) =>
      String(args[0]).endsWith(name)
        ? new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes);
                controller.error(new Error("aborted"));
              },
            }),
          )
        : normal(...args),
    );
    await expect(
      downloadReleaseUpdate(identity, candidate, { directory, request }),
    ).rejects.toThrow("aborted");
    expect(await readdir(directory)).toEqual([]);
  });
  it("does not download in source builds", async () => {
    const request = fixture();
    await expect(
      downloadReleaseUpdate({ ...identity, development: true }, candidate, {
        directory: await temporary(),
        request,
      }),
    ).rejects.toThrow("source");
    expect(request).not.toHaveBeenCalled();
  });
});
describe("install coordination", () => {
  it("holds a lock across calls and releases it", async () => {
    const dir = await temporary();
    const release = await acquireInstallLock(dir);
    await expect(acquireInstallLock(dir)).rejects.toThrow("in progress");
    await release();
    await (
      await acquireInstallLock(dir)
    )();
  });
  it("does not reclaim a stale lock with a live owner", async () => {
    const dir = await temporary();
    const file = path.join(dir, "install.lock");
    await writeFile(file, JSON.stringify({ token: "other", pid: process.pid }));
    const old = new Date(Date.now() - 300_000);
    await utimes(file, old, old);
    await expect(acquireInstallLock(dir)).rejects.toThrow("in progress");
    expect(JSON.parse(await readFile(file, "utf8")).token).toBe("other");
  });
  it.each(["", JSON.stringify({ token: "crashed", pid: 99_999_999 })])(
    "reclaims an old crashed or incomplete lock: %s",
    async (contents) => {
      const dir = await temporary();
      const old = new Date(Date.now() - 300_000);
      for (const name of ["install.lock", "install.lock.reclaim"]) {
        const file = path.join(dir, name);
        await writeFile(file, contents);
        await utimes(file, old, old);
      }
      const release = await acquireInstallLock(dir);
      expect(
        JSON.parse(await readFile(path.join(dir, "install.lock"), "utf8")).pid,
      ).toBe(process.pid);
      await release();
    },
  );
  it("does not reclaim a fresh incomplete lock", async () => {
    const dir = await temporary();
    await writeFile(path.join(dir, "install.lock"), "");
    await expect(acquireInstallLock(dir)).rejects.toThrow("in progress");
  });
  it("tolerates a missing lock during release", async () => {
    const dir = await temporary();
    const release = await acquireInstallLock(dir);
    await rm(path.join(dir, "install.lock"));
    await expect(release()).resolves.toBeUndefined();
  });
});
