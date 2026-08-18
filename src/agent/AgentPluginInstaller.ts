import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";

import simpleGit from "simple-git";
import { extract as extractTar } from "tar";
import yauzl, { type Entry, type ZipFile } from "yauzl";

import type { AgentPluginPackageSnapshot } from "../core/agentPlugins/contracts.js";
import { loadAgentPluginPackage } from "../core/agentPlugins/validation.js";
import { agentLinkFetch } from "../util/httpDispatcher.js";
import { createNodePluginPackageFileSystem } from "./agentPluginFileSystem.js";
import type { AgentPluginSourceProvenance } from "./AgentPluginStore.js";
import { digestAgentPluginTree } from "./AgentPluginStore.js";
import {
  looksLikeArchivePath,
  sanitizeRemoteDisplay,
  type AgentPluginSource,
} from "./agentPluginSources.js";

const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_ARCHIVE_FILE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_PATH_BYTES = 1_024;
const MAX_COMPRESSION_RATIO = 1_000;
const MAX_CANDIDATE_DEPTH = 6;
const MAX_VISITED_DIRECTORIES = 5_000;
const MAX_CANDIDATES = 100;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "vendor",
  "dist",
  "build",
  ".cache",
  ".next",
]);

export interface AgentPluginInstallCandidate {
  readonly rootPath: string;
  readonly relativePath: string;
  readonly snapshot: AgentPluginPackageSnapshot;
  readonly digest: string;
}

export interface AcquiredAgentPluginSource {
  readonly source: AgentPluginSource;
  readonly stagingRoot: string;
  readonly materializedRoot: string;
  readonly provenance: AgentPluginSourceProvenance;
  readonly candidates: readonly AgentPluginInstallCandidate[];
  cleanup(): Promise<void>;
}

export interface AgentPluginInstallerOptions {
  readonly stagingParent?: string;
  readonly fetch?: typeof agentLinkFetch;
}

export class AgentPluginInstallerError extends Error {
  constructor(
    readonly code:
      | "download_failed"
      | "download_too_large"
      | "unsupported_remote"
      | "git_failed"
      | "archive_unsafe"
      | "archive_limit_exceeded"
      | "source_unsafe"
      | "no_plugin_found",
    message: string,
  ) {
    super(message);
    this.name = "AgentPluginInstallerError";
  }
}

export class AgentPluginInstaller {
  private readonly fetch: typeof agentLinkFetch;

  constructor(
    private readonly options: Readonly<AgentPluginInstallerOptions> = {},
  ) {
    this.fetch = options.fetch ?? agentLinkFetch;
  }

  async acquire(
    source: Readonly<AgentPluginSource>,
    signal?: AbortSignal,
  ): Promise<AcquiredAgentPluginSource> {
    if (process.platform === "win32") {
      throw new AgentPluginInstallerError(
        "source_unsafe",
        "Agent Plugins v1 installation is unavailable on Windows.",
      );
    }
    const stagingRoot = await fs.mkdtemp(
      path.join(this.options.stagingParent ?? os.tmpdir(), "agentlink-plugin-"),
    );
    const materializedRoot = path.join(stagingRoot, "source");
    let complete = false;
    try {
      const provenance = await this.materialize(
        source,
        stagingRoot,
        materializedRoot,
        signal,
      );
      signal?.throwIfAborted();
      const candidates = await discoverAgentPluginCandidates(materializedRoot);
      const validCandidates = candidates.filter(
        (candidate) => candidate.snapshot.valid && candidate.snapshot.manifest,
      );
      if (validCandidates.length === 0) {
        const diagnostics = candidates
          .flatMap((candidate) => candidate.snapshot.diagnostics)
          .slice(0, 8)
          .map((diagnostic) => diagnostic.message)
          .join("; ");
        throw new AgentPluginInstallerError(
          "no_plugin_found",
          `No standards-compliant Agent Plugins 1.0.0 package was found${diagnostics ? `: ${diagnostics}` : "."}`,
        );
      }
      complete = true;
      return {
        source,
        stagingRoot,
        materializedRoot,
        provenance,
        candidates: validCandidates,
        cleanup: () => fs.rm(stagingRoot, { recursive: true, force: true }),
      };
    } finally {
      if (!complete) {
        await fs.rm(stagingRoot, { recursive: true, force: true });
      }
    }
  }

  private async materialize(
    source: Readonly<AgentPluginSource>,
    stagingRoot: string,
    destination: string,
    signal?: AbortSignal,
  ): Promise<AgentPluginSourceProvenance> {
    if (source.kind === "local-directory") {
      await copyLocalTree(source.path, destination, signal);
      const sourceDigest = await digestAgentPluginTree(destination);
      return source.workspaceRelativePath
        ? {
            kind: "workspace-directory",
            path: source.workspaceRelativePath,
            sourceDigest,
          }
        : {
            kind: "local-directory",
            label: safeLocalLabel(source.path),
            sourceDigest,
          };
    }
    if (source.kind === "local-archive") {
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      await extractArchive(source.path, destination, signal);
      return {
        kind: "local-archive",
        label: safeLocalLabel(source.path),
        sourceDigest: await digestAgentPluginTree(destination),
      };
    }
    if (source.kind === "git") {
      return this.materializeGit(source, destination, signal);
    }
    if (source.hint === "git") {
      return this.materializeGit(
        {
          kind: "git",
          remote: source.url,
          display: source.display,
        },
        destination,
        signal,
      );
    }

    const downloadedPath = path.join(
      stagingRoot,
      looksLikeArchivePath(new URL(source.url).pathname)
        ? path.basename(new URL(source.url).pathname)
        : "download",
    );
    const response = await this.download(source.url, downloadedPath, signal);
    if (isArchiveResponse(response, source.url)) {
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      await extractArchive(downloadedPath, destination, signal);
      return {
        kind: "remote-archive",
        url: sanitizeRemoteDisplay(response.url || source.url),
        sourceDigest: await digestAgentPluginTree(destination),
      };
    }
    if (source.hint !== "archive") {
      await fs.rm(downloadedPath, { force: true });
      if (new URL(source.url).protocol === "http:") {
        throw new AgentPluginInstallerError(
          "unsupported_remote",
          "The HTTP source was not a recognized archive. Git remotes must use HTTPS or SSH.",
        );
      }
      return this.materializeGit(
        {
          kind: "git",
          remote: source.url,
          display: source.display,
        },
        destination,
        signal,
      );
    }
    throw new AgentPluginInstallerError(
      "unsupported_remote",
      "The remote source was not a recognized ZIP/TAR archive or Git repository.",
    );
  }

  private async materializeGit(
    source: Extract<AgentPluginSource, { kind: "git" }>,
    destination: string,
    signal?: AbortSignal,
  ): Promise<AgentPluginSourceProvenance> {
    signal?.throwIfAborted();
    const clonePath = `${destination}.git-source`;
    const archivePath = `${destination}.git-archive.tar`;
    const git = simpleGit({
      binary: "git",
      maxConcurrentProcesses: 1,
      trimmed: true,
    }).env({
      GIT_ALLOW_PROTOCOL: "https:ssh",
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: "protocol.ext.allow",
      GIT_CONFIG_VALUE_0: "never",
      GIT_CONFIG_KEY_1: "protocol.file.allow",
      GIT_CONFIG_VALUE_1: "never",
      GIT_CONFIG_KEY_2: "protocol.git.allow",
      GIT_CONFIG_VALUE_2: "never",
      GIT_CONFIG_KEY_3: "core.hooksPath",
      GIT_CONFIG_VALUE_3: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
    });
    try {
      const args = [
        "clone",
        ...(source.commit ? [] : ["--depth=1"]),
        "--no-checkout",
        "--filter=blob:none",
        "--config",
        "core.hooksPath=/dev/null",
      ];
      if (source.ref && !source.commit) args.push("--branch", source.ref);
      args.push("--", source.remote, clonePath);
      await git.raw(args);
      signal?.throwIfAborted();
      const repository = simpleGit({
        baseDir: clonePath,
        binary: "git",
        maxConcurrentProcesses: 1,
        trimmed: true,
      }).env({
        GIT_ALLOW_PROTOCOL: "https:ssh",
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_0: "protocol.ext.allow",
        GIT_CONFIG_VALUE_0: "never",
        GIT_CONFIG_KEY_1: "protocol.file.allow",
        GIT_CONFIG_VALUE_1: "never",
        GIT_CONFIG_KEY_2: "core.hooksPath",
        GIT_CONFIG_VALUE_2: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      });
      if (source.commit) {
        await repository.raw(["fetch", "--depth=1", "origin", source.commit]);
      }
      const commit = (
        await repository.revparse([source.commit ?? "HEAD"])
      ).trim();
      if (source.commit && commit !== source.commit) {
        throw new Error(
          `Resolved Git commit '${commit}' does not match declared commit '${source.commit}'.`,
        );
      }
      await repository.raw([
        "archive",
        "--format=tar",
        `--output=${archivePath}`,
        commit,
      ]);
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      await extractTarArchive(archivePath, destination, signal, true);
      await fs.rm(clonePath, { recursive: true, force: true });
      await fs.rm(archivePath, { force: true });
      return {
        kind: "git",
        remote: sanitizeRemoteDisplay(source.remote),
        commit,
        ...(source.ref ? { ref: source.ref } : {}),
      };
    } catch (error) {
      throw new AgentPluginInstallerError(
        "git_failed",
        `Git acquisition failed: ${boundedErrorMessage(error)}`,
      );
    }
  }

  private async download(
    url: string,
    destination: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        redirect: "follow",
        signal,
        headers: {
          Accept:
            "application/zip, application/x-tar, application/gzip, application/octet-stream",
        },
      });
    } catch (error) {
      throw new AgentPluginInstallerError(
        "download_failed",
        `Plugin download failed: ${boundedErrorMessage(error)}`,
      );
    }
    if (!response.ok || !response.body) {
      throw new AgentPluginInstallerError(
        "download_failed",
        `Plugin download failed with HTTP ${response.status}.`,
      );
    }
    const finalUrl = new URL(response.url || url);
    if (finalUrl.protocol !== "https:" && finalUrl.protocol !== "http:") {
      throw new AgentPluginInstallerError(
        "download_failed",
        "Plugin download redirected to an unsupported protocol.",
      );
    }
    finalUrl.username = "";
    finalUrl.password = "";
    finalUrl.hash = "";
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) {
      throw new AgentPluginInstallerError(
        "download_too_large",
        `Plugin download exceeds ${formatBytes(MAX_DOWNLOAD_BYTES)}.`,
      );
    }
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const handle = await fs.open(destination, "wx", 0o600);
    let bytes = 0;
    try {
      const reader = response.body.getReader();
      while (true) {
        signal?.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_DOWNLOAD_BYTES) {
          throw new AgentPluginInstallerError(
            "download_too_large",
            `Plugin download exceeds ${formatBytes(MAX_DOWNLOAD_BYTES)}.`,
          );
        }
        await handle.write(chunk.value);
      }
    } finally {
      await handle.close();
    }
    return response;
  }
}

export async function discoverAgentPluginCandidates(
  rootPath: string,
): Promise<readonly AgentPluginInstallCandidate[]> {
  const fileSystem = createNodePluginPackageFileSystem();
  const candidates: AgentPluginInstallCandidate[] = [];
  let visitedDirectories = 0;
  const walk = async (
    directory: string,
    relativePath: string,
    depth: number,
  ) => {
    if (++visitedDirectories > MAX_VISITED_DIRECTORIES) {
      throw new AgentPluginInstallerError(
        "source_unsafe",
        `Plugin source contains more than ${MAX_VISITED_DIRECTORIES} directories.`,
      );
    }
    let entries: nodeFs.Dirent<string>[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const manifest = entries.find(
      (entry) => entry.name === "plugin.json" && entry.isFile(),
    );
    if (manifest) {
      if (candidates.length >= MAX_CANDIDATES) {
        throw new AgentPluginInstallerError(
          "source_unsafe",
          `Plugin source contains more than ${MAX_CANDIDATES} candidates.`,
        );
      }
      const snapshot = await loadAgentPluginPackage({
        rootPath: directory,
        fileSystem,
      });
      candidates.push({
        rootPath: directory,
        relativePath: relativePath || ".",
        snapshot,
        digest: await digestAgentPluginTree(directory),
      });
      return;
    }
    if (depth >= MAX_CANDIDATE_DEPTH) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await walk(
        path.join(directory, entry.name),
        relativePath ? path.posix.join(relativePath, entry.name) : entry.name,
        depth + 1,
      );
    }
  };
  await walk(rootPath, "", 0);
  return candidates;
}

async function copyLocalTree(
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const sourceRoot = await fs.realpath(source);
  const walk = async (from: string, to: string): Promise<void> => {
    signal?.throwIfAborted();
    const stat = await fs.lstat(from);
    if (stat.isDirectory()) {
      await fs.mkdir(to, { recursive: true, mode: stat.mode & 0o777 });
      const entries = await fs.readdir(from);
      entries.sort();
      for (const entry of entries) {
        if (entry === ".git") continue;
        await walk(path.join(from, entry), path.join(to, entry));
      }
      return;
    }
    if (stat.isFile()) {
      await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      await fs.chmod(to, stat.mode & 0o777);
      return;
    }
    if (stat.isSymbolicLink()) {
      const resolved = await fs.realpath(from);
      if (!isWithin(sourceRoot, resolved)) {
        throw new AgentPluginInstallerError(
          "source_unsafe",
          `Local plugin symlink escapes the source root: ${from}`,
        );
      }
      const managedTarget = path.join(
        destination,
        path.relative(sourceRoot, resolved),
      );
      await fs.symlink(path.relative(path.dirname(to), managedTarget), to);
      return;
    }
    throw new AgentPluginInstallerError(
      "source_unsafe",
      `Unsupported special file in plugin source: ${from}`,
    );
  };
  await walk(sourceRoot, destination);
}

async function extractArchive(
  archivePath: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".zip") || (await hasZipSignature(archivePath))) {
    await extractZip(archivePath, destination, signal);
    return;
  }
  await extractTarArchive(archivePath, destination, signal);
}

async function extractZip(
  archivePath: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  let zipFile: ZipFile;
  try {
    zipFile = await openZip(archivePath);
  } catch (error) {
    throw archiveUnsafe(
      `Invalid or unsafe ZIP archive: ${boundedErrorMessage(error)}`,
    );
  }
  const seen = new Set<string>();
  let entries = 0;
  let totalBytes = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      let entry: Entry | undefined;
      try {
        entry = await readZipEntry(zipFile);
      } catch (error) {
        throw archiveUnsafe(
          `Invalid or unsafe ZIP entry: ${boundedErrorMessage(error)}`,
        );
      }
      if (!entry) break;
      entries++;
      if (entries > MAX_ARCHIVE_ENTRIES) {
        throw archiveLimit(
          `Archive has more than ${MAX_ARCHIVE_ENTRIES} entries.`,
        );
      }
      const normalized = validateArchivePath(entry.fileName, destination, seen);
      const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
      const type = mode & 0o170000;
      if (type === 0o120000) {
        throw archiveUnsafe(
          `Archive symlink is not allowed: ${entry.fileName}`,
        );
      }
      if (type !== 0 && type !== 0o040000 && type !== 0o100000) {
        throw archiveUnsafe(
          `Unsupported archive entry type: ${entry.fileName}`,
        );
      }
      const directory = entry.fileName.endsWith("/") || type === 0o040000;
      if (directory) {
        await fs.mkdir(path.join(destination, normalized), {
          recursive: true,
          mode: 0o700,
        });
        continue;
      }
      if (entry.uncompressedSize > MAX_ARCHIVE_FILE_BYTES) {
        throw archiveLimit(`Archive file is too large: ${entry.fileName}`);
      }
      totalBytes += entry.uncompressedSize;
      if (totalBytes > MAX_ARCHIVE_TOTAL_BYTES) {
        throw archiveLimit(
          `Archive expands beyond ${formatBytes(MAX_ARCHIVE_TOTAL_BYTES)}.`,
        );
      }
      if (
        entry.uncompressedSize > 0 &&
        entry.uncompressedSize / Math.max(1, entry.compressedSize) >
          MAX_COMPRESSION_RATIO
      ) {
        throw archiveLimit(
          `Archive compression ratio is unsafe: ${entry.fileName}`,
        );
      }
      const outputPath = path.join(destination, normalized);
      await fs.mkdir(path.dirname(outputPath), {
        recursive: true,
        mode: 0o700,
      });
      const input = await openZipEntry(zipFile, entry);
      const output = nodeFs.createWriteStream(outputPath, {
        flags: "wx",
        mode: mode & 0o111 ? 0o755 : 0o644,
      });
      await pipeline(input, output, { signal });
    }
  } finally {
    zipFile.close();
  }
}

async function extractTarArchive(
  archivePath: string,
  destination: string,
  signal?: AbortSignal,
  allowSymlinks = false,
): Promise<void> {
  const seen = new Set<string>();
  let entries = 0;
  let totalBytes = 0;
  await extractTar({
    file: archivePath,
    cwd: destination,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    noMtime: true,
    unlink: true,
    maxDepth: MAX_CANDIDATE_DEPTH + 8,
    maxDecompressionRatio: MAX_COMPRESSION_RATIO,
    onReadEntry: (entry) => {
      signal?.throwIfAborted();
      entries++;
      if (entries > MAX_ARCHIVE_ENTRIES) {
        throw archiveLimit(
          `Archive has more than ${MAX_ARCHIVE_ENTRIES} entries.`,
        );
      }
      validateArchivePath(entry.path, destination, seen);
      if (entry.size > MAX_ARCHIVE_FILE_BYTES) {
        throw archiveLimit(`Archive file is too large: ${entry.path}`);
      }
      totalBytes += entry.size;
      if (totalBytes > MAX_ARCHIVE_TOTAL_BYTES) {
        throw archiveLimit(
          `Archive expands beyond ${formatBytes(MAX_ARCHIVE_TOTAL_BYTES)}.`,
        );
      }
      if (
        entry.type !== "File" &&
        entry.type !== "OldFile" &&
        entry.type !== "Directory" &&
        !(allowSymlinks && entry.type === "SymbolicLink")
      ) {
        throw archiveUnsafe(`Unsupported TAR entry type: ${entry.path}`);
      }
      if (entry.type === "SymbolicLink") {
        validateAgentPluginArchiveSymlinkTarget(
          entry.path,
          entry.linkpath,
          destination,
        );
      }
    },
  });
}

function validateArchivePath(
  entryPath: string,
  destination: string,
  seen: Set<string>,
): string {
  if (
    !entryPath ||
    entryPath.includes("\0") ||
    Buffer.byteLength(entryPath, "utf8") > MAX_ARCHIVE_PATH_BYTES ||
    entryPath.startsWith("/") ||
    entryPath.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(entryPath)
  ) {
    throw archiveUnsafe(`Unsafe archive path: ${entryPath}`);
  }
  const posix = entryPath.replaceAll("\\", "/");
  const parts = posix.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw archiveUnsafe(`Unsafe archive traversal path: ${entryPath}`);
  }
  const normalized = parts.join("/");
  const destinationPath = path.resolve(destination, ...parts);
  if (!isWithin(path.resolve(destination), destinationPath)) {
    throw archiveUnsafe(`Archive path escapes staging: ${entryPath}`);
  }
  const caseKey = normalized.normalize("NFC").toLocaleLowerCase("en-US");
  if (seen.has(caseKey)) {
    throw archiveUnsafe(
      `Duplicate or case-colliding archive path: ${entryPath}`,
    );
  }
  seen.add(caseKey);
  return normalized;
}

export function validateAgentPluginArchiveSymlinkTarget(
  entryPath: string,
  linkPath: string | undefined,
  destination: string,
): void {
  if (
    !linkPath ||
    linkPath.includes("\0") ||
    path.posix.isAbsolute(linkPath) ||
    path.win32.isAbsolute(linkPath)
  ) {
    throw archiveUnsafe(`Unsafe archive symlink target: ${entryPath}`);
  }
  const entryDirectory = path.dirname(
    path.resolve(destination, ...entryPath.replaceAll("\\", "/").split("/")),
  );
  const resolvedTarget = path.resolve(
    entryDirectory,
    ...linkPath.replaceAll("\\", "/").split("/"),
  );
  if (!isWithin(path.resolve(destination), resolvedTarget)) {
    throw archiveUnsafe(`Archive symlink escapes staging: ${entryPath}`);
  }
}

function isArchiveResponse(response: Response, url: string): boolean {
  const contentType = (
    response.headers.get("content-type") ?? ""
  ).toLowerCase();
  return (
    looksLikeArchivePath(new URL(response.url || url).pathname) ||
    contentType.includes("zip") ||
    contentType.includes("tar") ||
    contentType.includes("gzip") ||
    contentType.includes("bzip") ||
    contentType.includes("xz") ||
    contentType.includes("octet-stream")
  );
}

function safeLocalLabel(sourcePath: string): string {
  return path.basename(sourcePath) || "local-plugin";
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function hasZipSignature(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    return bytesRead === 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  } finally {
    await handle.close();
  }
}

function openZip(filePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      filePath,
      { lazyEntries: true, decodeStrings: true },
      (error, zip) =>
        error || !zip
          ? reject(error ?? new Error("Unable to open ZIP"))
          : resolve(zip),
    );
  });
}

function readZipEntry(zipFile: ZipFile): Promise<Entry | undefined> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(undefined);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      zipFile.off("entry", onEntry);
      zipFile.off("end", onEnd);
      zipFile.off("error", onError);
    };
    zipFile.once("entry", onEntry);
    zipFile.once("end", onEnd);
    zipFile.once("error", onError);
    zipFile.readEntry();
  });
}

function openZipEntry(
  zipFile: ZipFile,
  entry: Entry,
): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) =>
      error || !stream
        ? reject(error ?? new Error("Unable to read ZIP entry"))
        : resolve(stream),
    );
  });
}

function archiveUnsafe(message: string): AgentPluginInstallerError {
  return new AgentPluginInstallerError("archive_unsafe", message);
}

function archiveLimit(message: string): AgentPluginInstallerError {
  return new AgentPluginInstallerError("archive_limit_exceeded", message);
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 2_000 ? message : `${message.slice(0, 2_000)}…`;
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}
