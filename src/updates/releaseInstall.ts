import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import {
  compatibleRelease,
  compareReleaseVersions,
  parseReleaseUpdateMetadata,
} from "./releaseSelection.js";
import {
  RELEASE_REPOSITORY_URL,
  type ReleaseUpdateCandidate,
  type ReleaseUpdateIdentity,
} from "./releaseUpdateTypes.js";

export interface ReleaseInstallState {
  phase:
    | "idle"
    | "preparing"
    | "downloading"
    | "verifying"
    | "installing"
    | "ready_to_restart"
    | "installed"
    | "failed"
    | "blocked";
  version?: string;
  message?: string;
  received?: number;
  total?: number;
}

const allowedHosts = new Set([
  "api.github.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

async function requestRelease(
  url: string,
  signal: AbortSignal,
  request: typeof fetch,
): Promise<Response> {
  for (let redirects = 0; redirects <= 3; redirects++) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      !allowedHosts.has(parsed.hostname)
    )
      throw new Error("Unexpected release download URL.");
    const response = await request(url, {
      signal,
      redirect: "manual",
      headers: {
        Accept:
          parsed.hostname === "api.github.com"
            ? "application/vnd.github+json"
            : "application/octet-stream",
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Release redirect has no location.");
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Release download failed (HTTP ${response.status}).`);
    }
    return response;
  }
  throw new Error("Too many release redirects.");
}

async function readBounded(response: Response, limit: number): Promise<string> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > limit) throw new Error("Release response is too large.");
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel();
  }
}

export async function downloadReleaseUpdate(
  identity: ReleaseUpdateIdentity,
  candidate: ReleaseUpdateCandidate,
  options: {
    directory: string;
    signal?: AbortSignal;
    onState?: (state: ReleaseInstallState) => void;
    request?: typeof fetch;
  },
): Promise<string> {
  if (identity.development)
    throw new Error("Source builds must be updated from source.");
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(15 * 60_000),
  ]);
  const request = options.request ?? fetch;
  const report = (state: ReleaseInstallState) =>
    options.onState?.({ ...state, version: candidate.version });
  report({ phase: "preparing" });
  if (
    !/^\d+\.\d+\.\d+$/.test(candidate.version) ||
    candidate.tag !==
      `${identity.product === "vscode" ? "v" : `${identity.product}-v`}${candidate.version}` ||
    candidate.target !== identity.target ||
    compareReleaseVersions(candidate.version, identity.version) <= 0
  )
    throw new Error("Invalid update candidate.");
  const release = JSON.parse(
    await readBounded(
      await requestRelease(
        `https://api.github.com/repos/reefbarman/agentlink/releases/tags/${candidate.tag}`,
        signal,
        request,
      ),
      4 * 1024 * 1024,
    ),
  ) as {
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    published_at: string | null;
    assets: { name: string; browser_download_url: string; digest?: string }[];
  };
  if (
    release.tag_name !== candidate.tag ||
    release.draft !== false ||
    !release.published_at ||
    typeof release.prerelease !== "boolean" ||
    !Array.isArray(release.assets)
  )
    throw new Error("Release is not published.");
  const base = `${RELEASE_REPOSITORY_URL}/releases/download/${candidate.tag}/`;
  const asset = (name: string) => {
    const matches = release.assets.filter((entry) => entry.name === name);
    if (
      matches.length !== 1 ||
      matches[0].browser_download_url !== `${base}${name}`
    )
      throw new Error(`Release has no verified ${name} asset.`);
    return matches[0];
  };
  const metadata = parseReleaseUpdateMetadata(
    JSON.parse(
      await readBounded(
        await requestRelease(
          asset("agentlink-update.json").browser_download_url,
          signal,
          request,
        ),
        64 * 1024,
      ),
    ),
    identity.product,
    candidate.tag,
  );
  if (
    !metadata ||
    !compatibleRelease(
      {
        metadata,
        assets: release.assets.map((entry) => entry.name),
        prerelease: release.prerelease,
      },
      identity,
    )
  )
    throw new Error("Release is not compatible with this host.");
  const selected = asset(metadata.targets[identity.target]);
  const sums = await readBounded(
    await requestRelease(
      asset("SHA256SUMS").browser_download_url,
      signal,
      request,
    ),
    64 * 1024,
  );
  const entries = sums
    .split(/\r?\n/)
    .map((line) => /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line))
    .filter((entry) => entry?.[2] === selected.name);
  if (entries.length !== 1)
    throw new Error("Release checksum is missing or ambiguous.");
  const expected = entries[0]![1].toLowerCase();
  if (selected.digest && selected.digest !== `sha256:${expected}`)
    throw new Error("GitHub digest does not match the release checksum.");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const destination = path.join(options.directory, selected.name);
  const partial = `${destination}.${randomUUID()}.partial`;
  const handle = await open(partial, "wx", 0o600);
  try {
    const response = await requestRelease(
      selected.browser_download_url,
      signal,
      request,
    );
    const total = Number(response.headers.get("content-length")) || undefined;
    const limit = (identity.product === "desktop" ? 600 : 300) * 1024 * 1024;
    if (total && total > limit) {
      await response.body!.cancel();
      throw new Error("Release artifact is too large.");
    }
    const hash = createHash("sha256");
    const reader = response.body!.getReader();
    let received = 0;
    let lastReport = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.length;
        if (received > limit) throw new Error("Release artifact is too large.");
        hash.update(chunk.value);
        await handle.writeFile(chunk.value);
        if (Date.now() - lastReport > 250) {
          report({ phase: "downloading", received, total });
          lastReport = Date.now();
        }
      }
    } finally {
      await reader.cancel();
    }
    report({ phase: "verifying", received, total });
    if (hash.digest("hex") !== expected)
      throw new Error(
        "Release SHA-256 checksum mismatch. Nothing was installed.",
      );
    await handle.close();
    await rename(partial, destination);
    return destination;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(partial, { force: true });
    throw error;
  }
}

export async function acquireInstallLock(
  directory: string,
): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "install.lock");
  const token = randomUUID();
  const isStale = async (lockFile: string) => {
    const info = await stat(lockFile);
    if (Date.now() - info.mtimeMs < 120_000) return false;
    let owner: { pid?: unknown } | null = null;
    try {
      owner = JSON.parse(await readFile(lockFile, "utf8"));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (
      typeof owner?.pid !== "number" ||
      !Number.isInteger(owner.pid) ||
      owner.pid <= 0
    )
      return true;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  };
  const create = async (lockFile = file) => {
    const handle = await open(lockFile, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ token, pid: process.pid }));
    } finally {
      await handle.close();
    }
  };
  try {
    await create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const reclaimFile = `${file}.reclaim`;
    try {
      await create(reclaimFile);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      if (!(await isStale(reclaimFile)))
        throw new Error("Another update is in progress.");
      await rm(reclaimFile);
      await create(reclaimFile);
    }
    try {
      if (!(await isStale(file)))
        throw new Error("Another update is in progress.");
      await rm(file);
      await create();
    } finally {
      const owner = JSON.parse(await readFile(reclaimFile, "utf8")) as {
        token: string;
      };
      if (owner.token === token) await rm(reclaimFile);
    }
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(file, now, now).catch(() => undefined);
  }, 15_000);
  heartbeat.unref();
  return async () => {
    clearInterval(heartbeat);
    try {
      const owner = JSON.parse(await readFile(file, "utf8")) as {
        token: string;
      };
      if (owner.token === token) await rm(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
}
