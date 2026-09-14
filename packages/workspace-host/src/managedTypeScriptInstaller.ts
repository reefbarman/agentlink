import { createHash, randomUUID } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";

import { gunzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";

const INSTALLATION_SCHEMA_VERSION = 1;
const CURRENT_SCHEMA_VERSION = 1;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 160 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const FORBIDDEN_LIFECYCLE_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
] as const;

export interface ManagedTypeScriptPackageRecipe {
  readonly name: "typescript-language-server" | "typescript";
  readonly version: string;
  readonly url: string;
  readonly integrity: `sha512-${string}`;
}

export interface ManagedTypeScriptRecipe {
  readonly id: string;
  readonly languageServer: ManagedTypeScriptPackageRecipe;
  readonly typescript: ManagedTypeScriptPackageRecipe;
}

export const MANAGED_TYPESCRIPT_RECIPE: ManagedTypeScriptRecipe = {
  id: "typescript-language-server-5.3.0_typescript-5.9.3",
  languageServer: {
    name: "typescript-language-server",
    version: "5.3.0",
    url: "https://registry.npmjs.org/typescript-language-server/-/typescript-language-server-5.3.0.tgz",
    integrity:
      "sha512-5puofxZHgFdAYtfNpmwCAvgtaYgg8wrUnH30m7Ze3QuguId5RNRadKASpOpyDxTyUdAF51FjhTdjntLw/EuWcQ==",
  },
  typescript: {
    name: "typescript",
    version: "5.9.3",
    url: "https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz",
    integrity:
      "sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==",
  },
};

interface InstalledPackageRecord {
  readonly name: string;
  readonly version: string;
  readonly archive: string;
  readonly integrity: string;
  readonly treeSha256: string;
  readonly license: string;
  readonly licenseFiles: readonly string[];
}

interface InstallationManifest {
  readonly schemaVersion: typeof INSTALLATION_SCHEMA_VERSION;
  readonly recipeId: string;
  readonly installedAt: string;
  readonly packages: readonly InstalledPackageRecord[];
}

export type ManagedTypeScriptStatus =
  | {
      readonly state: "unavailable";
      readonly recipe: ManagedTypeScriptRecipe;
      readonly reason: "not_installed";
    }
  | {
      readonly state: "ready";
      readonly recipe: ManagedTypeScriptRecipe;
      readonly installedAt: string;
      readonly installationRoot: string;
      readonly languageServerModule: string;
      readonly tsserverPath: string;
      readonly licenses: readonly string[];
    }
  | {
      readonly state: "corrupt";
      readonly recipe: ManagedTypeScriptRecipe;
      readonly reason: string;
    };

export interface InstallManagedTypeScriptOptions {
  readonly dataRoot: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly force?: boolean;
  /** Override for deterministic installer tests and future curated recipe updates. */
  readonly recipe?: ManagedTypeScriptRecipe;
}

export async function installManagedTypeScriptLanguageServer(
  options: InstallManagedTypeScriptOptions,
): Promise<ManagedTypeScriptStatus> {
  assertAbsoluteDataRoot(options.dataRoot);
  const recipe = options.recipe ?? MANAGED_TYPESCRIPT_RECIPE;
  validateRecipe(recipe);
  const paths = managedPaths(options.dataRoot, recipe);
  await preparePrivateDirectory(paths.root);
  return await withOperationLock(paths.root, async () => {
    if (!options.force) {
      const current = await getManagedTypeScriptStatus(
        options.dataRoot,
        recipe,
      );
      if (current.state === "ready") return current;
    }

    const stagingRoot = path.join(paths.staging, randomUUID());
    const stagedInstallation = path.join(stagingRoot, "installation");
    await preparePrivateDirectory(stagedInstallation);
    try {
      const records: InstalledPackageRecord[] = [];
      for (const packageRecipe of [recipe.languageServer, recipe.typescript]) {
        records.push(
          await downloadAndExtractPackage(
            packageRecipe,
            stagedInstallation,
            options.fetch ?? globalThis.fetch,
          ),
        );
      }
      const manifest: InstallationManifest = {
        schemaVersion: INSTALLATION_SCHEMA_VERSION,
        recipeId: recipe.id,
        installedAt: new Date().toISOString(),
        packages: records,
      };
      await writePrivateJson(
        path.join(stagedInstallation, "installation.json"),
        manifest,
      );
      await publishInstallation(
        stagedInstallation,
        paths.installation,
        paths.recipes,
      );
      await publishCurrent(paths.current, recipe.id);
    } finally {
      await fs.rm(stagingRoot, { recursive: true, force: true });
    }

    return await getManagedTypeScriptStatus(options.dataRoot, recipe);
  });
}

export async function updateManagedTypeScriptLanguageServer(
  options: Omit<InstallManagedTypeScriptOptions, "force">,
): Promise<ManagedTypeScriptStatus> {
  return await installManagedTypeScriptLanguageServer({
    ...options,
    force: true,
  });
}

export async function removeManagedTypeScriptLanguageServer(
  dataRoot: string,
): Promise<boolean> {
  assertAbsoluteDataRoot(dataRoot);
  const paths = managedPaths(dataRoot);
  if (!(await pathExists(paths.root))) return false;
  await assertNotSymbolicLink(paths.root);
  return await withOperationLock(paths.root, async () => {
    const hadInstallation =
      (await pathExists(paths.current)) || (await pathExists(paths.recipes));
    await fs.rm(paths.current, { force: true });
    await fs.rm(paths.recipes, { recursive: true, force: true });
    await fs.rm(paths.staging, { recursive: true, force: true });
    return hadInstallation;
  });
}

export async function getManagedTypeScriptStatus(
  dataRoot: string,
  recipe: ManagedTypeScriptRecipe = MANAGED_TYPESCRIPT_RECIPE,
): Promise<ManagedTypeScriptStatus> {
  assertAbsoluteDataRoot(dataRoot);
  validateRecipe(recipe);
  const paths = managedPaths(dataRoot, recipe);
  if (!(await pathExists(paths.current))) {
    return {
      state: "unavailable",
      recipe,
      reason: "not_installed",
    };
  }
  try {
    await assertNotSymbolicLink(paths.root);
    const current = parseCurrent(await fs.readFile(paths.current, "utf8"));
    if (current.recipeId !== recipe.id) {
      throw new Error(`unsupported_recipe:${current.recipeId}`);
    }
    const installationRoot = path.join(paths.recipes, current.recipeId);
    const manifest = parseManifest(
      await fs.readFile(
        path.join(installationRoot, "installation.json"),
        "utf8",
      ),
    );
    if (manifest.recipeId !== current.recipeId) {
      throw new Error("recipe_manifest_mismatch");
    }
    const expectedPackages = new Map(
      [recipe.languageServer, recipe.typescript].map((packageRecipe) => [
        packageRecipe.name,
        packageRecipe,
      ]),
    );
    if (manifest.packages.length !== expectedPackages.size) {
      throw new Error("package_closure_mismatch");
    }
    for (const record of manifest.packages) {
      const expected = expectedPackages.get(
        record.name as ManagedTypeScriptPackageRecipe["name"],
      );
      if (
        !expected ||
        expected.version !== record.version ||
        expected.integrity !== record.integrity
      ) {
        throw new Error(`package_recipe_mismatch:${record.name}`);
      }
      const archive = path.join(installationRoot, record.archive);
      assertPathWithin(installationRoot, archive);
      const archiveBytes = await fs.readFile(archive);
      verifyIntegrity(archiveBytes, record.integrity);
      const packageRoot = path.join(
        installationRoot,
        "node_modules",
        record.name,
      );
      if ((await hashDirectory(packageRoot)) !== record.treeSha256) {
        throw new Error(`package_tree_mismatch:${record.name}`);
      }
      for (const licenseFile of record.licenseFiles) {
        const resolved = path.join(packageRoot, licenseFile);
        assertPathWithin(packageRoot, resolved);
        await assertRegularFile(resolved);
      }
    }
    const languageServerModule = path.join(
      installationRoot,
      "node_modules/typescript-language-server/lib/cli.mjs",
    );
    const tsserverPath = path.join(
      installationRoot,
      "node_modules/typescript/lib/tsserver.js",
    );
    await Promise.all([
      assertRegularFile(languageServerModule),
      assertRegularFile(tsserverPath),
    ]);
    return {
      state: "ready",
      recipe,
      installedAt: manifest.installedAt,
      installationRoot,
      languageServerModule,
      tsserverPath,
      licenses: manifest.packages.flatMap((record) =>
        record.licenseFiles.map((file) =>
          path.join("node_modules", record.name, file),
        ),
      ),
    };
  } catch (error) {
    return {
      state: "corrupt",
      recipe,
      reason: errorCode(error),
    };
  }
}

async function downloadAndExtractPackage(
  recipe: ManagedTypeScriptPackageRecipe,
  installationRoot: string,
  fetchImplementation: typeof globalThis.fetch,
): Promise<InstalledPackageRecord> {
  const archiveBytes = await downloadArchive(recipe.url, fetchImplementation);
  verifyIntegrity(archiveBytes, recipe.integrity);
  const archiveDirectory = path.join(installationRoot, "archives");
  await preparePrivateDirectory(archiveDirectory);
  const archiveName = `${recipe.name}-${recipe.version}.tgz`;
  const archivePath = path.join(archiveDirectory, archiveName);
  await fs.writeFile(archivePath, archiveBytes, {
    mode: 0o600,
    flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
  });

  const packageRoot = path.join(installationRoot, "node_modules", recipe.name);
  await extractNpmArchive(archiveBytes, packageRoot);
  const packageManifest = parsePackageManifest(
    await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
  );
  if (
    packageManifest.name !== recipe.name ||
    packageManifest.version !== recipe.version
  ) {
    throw new Error(`package_identity_mismatch:${recipe.name}`);
  }
  for (const script of FORBIDDEN_LIFECYCLE_SCRIPTS) {
    if (packageManifest.scripts?.[script]) {
      throw new Error(`forbidden_lifecycle_script:${recipe.name}:${script}`);
    }
  }
  if (
    Object.keys(packageManifest.dependencies ?? {}).length > 0 ||
    Object.keys(packageManifest.optionalDependencies ?? {}).length > 0 ||
    packageManifest.bundledDependencies.length > 0
  ) {
    throw new Error(`unexpected_runtime_dependency:${recipe.name}`);
  }
  const licenseFiles = (await listRegularFiles(packageRoot)).filter((file) =>
    /^(?:licen[cs]e|notice|thirdpartynoticetext)(?:\..*)?$/iu.test(
      path.posix.basename(file),
    ),
  );
  if (licenseFiles.length === 0) {
    throw new Error(`missing_license_file:${recipe.name}`);
  }
  return {
    name: recipe.name,
    version: recipe.version,
    archive: path.posix.join("archives", archiveName),
    integrity: recipe.integrity,
    treeSha256: await hashDirectory(packageRoot),
    license: packageManifest.license,
    licenseFiles,
  };
}

async function downloadArchive(
  url: string,
  fetchImplementation: typeof globalThis.fetch,
): Promise<Buffer> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "registry.npmjs.org" ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("untrusted_archive_url");
  }
  const response = await fetchImplementation(url, {
    redirect: "error",
    headers: { Accept: "application/octet-stream" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`archive_download_failed:${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
    throw new Error("archive_too_large");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ARCHIVE_BYTES) throw new Error("archive_too_large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function verifyIntegrity(bytes: Buffer, integrity: string): void {
  const [algorithm, expected, extra] = integrity.split("-");
  if (algorithm !== "sha512" || !expected || extra) {
    throw new Error("unsupported_archive_integrity");
  }
  const actual = createHash("sha512").update(bytes).digest("base64");
  if (actual !== expected) throw new Error("archive_integrity_mismatch");
}

async function extractNpmArchive(
  archiveBytes: Buffer,
  destination: string,
): Promise<void> {
  const tar = gunzipSync(archiveBytes, { maxOutputLength: MAX_EXPANDED_BYTES });
  await preparePrivateDirectory(destination);
  let offset = 0;
  let entries = 0;
  let expandedBytes = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    verifyTarHeaderChecksum(header);
    entries += 1;
    if (entries > MAX_ARCHIVE_ENTRIES)
      throw new Error("archive_too_many_entries");
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const archivePath = prefix ? `${prefix}/${name}` : name;
    const size = tarOctal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] ?? 0);
    if (!archivePath.startsWith("package/")) {
      throw new Error("archive_invalid_package_root");
    }
    const relativePath = archivePath.slice("package/".length);
    assertSafeArchivePath(relativePath);
    expandedBytes += size;
    if (expandedBytes > MAX_EXPANDED_BYTES) {
      throw new Error("archive_expanded_too_large");
    }
    const contentEnd = offset + size;
    if (contentEnd > tar.length) throw new Error("archive_truncated");
    const target = path.join(destination, ...relativePath.split("/"));
    assertPathWithin(destination, target);
    if (type === "5") {
      if (size !== 0) throw new Error("archive_invalid_directory");
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
      await fs.chmod(target, 0o700);
    } else if (type === "0" || type === "\0") {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, tar.subarray(offset, contentEnd), {
        mode: 0o600,
        flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      });
    } else {
      throw new Error(`archive_entry_type_rejected:${type.charCodeAt(0)}`);
    }
    offset += Math.ceil(size / 512) * 512;
  }
}

function verifyTarHeaderChecksum(header: Buffer): void {
  const expected = tarOctal(header.subarray(148, 156));
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  }
  if (actual !== expected) throw new Error("archive_header_checksum_mismatch");
}

function tarString(bytes: Buffer): string {
  const nul = bytes.indexOf(0);
  return bytes.subarray(0, nul === -1 ? bytes.length : nul).toString("utf8");
}

function tarOctal(bytes: Buffer): number {
  const value = tarString(bytes).trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error("archive_invalid_number");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("archive_invalid_number");
  }
  return parsed;
}

function assertSafeArchivePath(relativePath: string): void {
  if (
    !relativePath ||
    relativePath.includes("\\") ||
    relativePath.startsWith("/") ||
    relativePath
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("archive_unsafe_path");
  }
}

async function publishInstallation(
  staging: string,
  destination: string,
  recipesRoot: string,
): Promise<void> {
  await preparePrivateDirectory(recipesRoot);
  const backup = `${destination}.replaced-${randomUUID()}`;
  let movedExisting = false;
  if (await pathExists(destination)) {
    await assertNotSymbolicLink(destination);
    await fs.rename(destination, backup);
    movedExisting = true;
  }
  try {
    await fs.rename(staging, destination);
    await syncDirectory(recipesRoot);
    if (movedExisting) {
      await fs
        .rm(backup, { recursive: true, force: true })
        .catch(() => undefined);
    }
  } catch (error) {
    if (movedExisting && !(await pathExists(destination))) {
      await fs.rename(backup, destination).catch(() => undefined);
    }
    throw error;
  }
}

async function publishCurrent(
  currentPath: string,
  recipeId: string,
): Promise<void> {
  const temporary = `${currentPath}.${randomUUID()}.tmp`;
  await writePrivateJson(temporary, {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    recipeId,
  });
  try {
    await fs.rename(temporary, currentPath);
    await fs.chmod(currentPath, 0o600);
    await syncDirectory(path.dirname(currentPath));
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

interface ManagedOperationLock {
  readonly nonce: string;
  readonly pid: number;
  readonly hostname: string;
}

async function withOperationLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(root, ".operation.lock");
  const lock: ManagedOperationLock = {
    nonce: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
  };
  const handle = await acquireOperationLock(lockPath, lock);
  try {
    return await operation();
  } finally {
    await handle.close();
    await releaseOperationLock(lockPath, lock.nonce);
  }
}

async function acquireOperationLock(
  lockPath: string,
  lock: ManagedOperationLock,
) {
  for (;;) {
    try {
      const handle = await fs.open(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600,
      );
      try {
        await handle.writeFile(`${JSON.stringify(lock)}\n`, "utf8");
        await handle.sync();
        return handle;
      } catch (error) {
        await handle.close();
        await fs.rm(lockPath, { force: true });
        throw error;
      }
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }

    const existingText = await fs.readFile(lockPath, "utf8").catch((error) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (existingText === undefined) continue;
    const existing = parseOperationLock(existingText);
    if (existing.hostname !== os.hostname() || isProcessAlive(existing.pid)) {
      throw new Error("managed_typescript_operation_in_progress");
    }
    const quarantine = `${lockPath}.stale-${randomUUID()}`;
    try {
      await fs.rename(lockPath, quarantine);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    const movedText = await fs.readFile(quarantine, "utf8");
    if (movedText !== existingText) {
      if (!(await pathExists(lockPath))) {
        await fs.rename(quarantine, lockPath).catch(() => undefined);
      }
      throw new Error("managed_typescript_operation_lock_changed");
    }
    await fs.unlink(quarantine);
  }
}

async function releaseOperationLock(
  lockPath: string,
  expectedNonce: string,
): Promise<void> {
  const text = await fs.readFile(lockPath, "utf8").catch(() => undefined);
  if (text === undefined) return;
  let current: ManagedOperationLock;
  try {
    current = parseOperationLock(text);
  } catch {
    return;
  }
  if (current.nonce !== expectedNonce) return;
  await fs.unlink(lockPath).catch((error) => {
    if (errorCode(error) !== "ENOENT") throw error;
  });
}

function parseOperationLock(text: string): ManagedOperationLock {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    typeof value.nonce !== "string" ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) <= 0 ||
    typeof value.hostname !== "string"
  ) {
    throw new Error("managed_typescript_operation_lock_invalid");
  }
  return {
    nonce: value.nonce,
    pid: Number(value.pid),
    hostname: value.hostname,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    return true;
  }
}

function managedPaths(
  dataRoot: string,
  recipe: ManagedTypeScriptRecipe = MANAGED_TYPESCRIPT_RECIPE,
) {
  const root = path.join(dataRoot, "language-servers", "typescript");
  const recipes = path.join(root, "recipes");
  return {
    root,
    recipes,
    staging: path.join(root, "staging"),
    current: path.join(root, "current.json"),
    installation: path.join(recipes, recipe.id),
  };
}

async function preparePrivateDirectory(directory: string): Promise<void> {
  if (await pathExists(directory)) await assertNotSymbolicLink(directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

async function writePrivateJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  const handle = await fs.open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function listRegularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix
        ? path.posix.join(prefix, entry.name)
        : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`installed_package_unsafe_entry:${relative}`);
    }
  }
  await visit(root, "");
  return files;
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const relative of await listRegularFiles(root)) {
    const absolute = path.join(root, ...relative.split("/"));
    const bytes = await fs.readFile(absolute);
    hash.update(`${relative}\0${bytes.length}\0`, "utf8");
    hash.update(bytes);
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function parseCurrent(text: string): {
  readonly schemaVersion: number;
  readonly recipeId: string;
} {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    value.schemaVersion !== CURRENT_SCHEMA_VERSION ||
    typeof value.recipeId !== "string"
  ) {
    throw new Error("invalid_current_manifest");
  }
  return { schemaVersion: value.schemaVersion, recipeId: value.recipeId };
}

function parseManifest(text: string): InstallationManifest {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    value.schemaVersion !== INSTALLATION_SCHEMA_VERSION ||
    typeof value.recipeId !== "string" ||
    typeof value.installedAt !== "string" ||
    !Array.isArray(value.packages)
  ) {
    throw new Error("invalid_installation_manifest");
  }
  const packages = value.packages.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      typeof entry.version !== "string" ||
      typeof entry.archive !== "string" ||
      typeof entry.integrity !== "string" ||
      typeof entry.treeSha256 !== "string" ||
      typeof entry.license !== "string" ||
      !Array.isArray(entry.licenseFiles) ||
      !entry.licenseFiles.every((file) => typeof file === "string")
    ) {
      throw new Error("invalid_installed_package_manifest");
    }
    return {
      name: entry.name,
      version: entry.version,
      archive: entry.archive,
      integrity: entry.integrity,
      treeSha256: entry.treeSha256,
      license: entry.license,
      licenseFiles: entry.licenseFiles,
    };
  });
  return {
    schemaVersion: INSTALLATION_SCHEMA_VERSION,
    recipeId: value.recipeId,
    installedAt: value.installedAt,
    packages,
  };
}

function parsePackageManifest(text: string): {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly bundledDependencies: readonly string[];
} {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.version !== "string" ||
    typeof value.license !== "string" ||
    (value.scripts !== undefined && !isStringRecord(value.scripts)) ||
    (value.dependencies !== undefined && !isStringRecord(value.dependencies)) ||
    (value.optionalDependencies !== undefined &&
      !isStringRecord(value.optionalDependencies)) ||
    (value.bundledDependencies !== undefined &&
      (!Array.isArray(value.bundledDependencies) ||
        !value.bundledDependencies.every((entry) => typeof entry === "string")))
  ) {
    throw new Error("invalid_package_manifest");
  }
  return {
    name: value.name,
    version: value.version,
    license: value.license,
    ...(value.scripts ? { scripts: value.scripts } : {}),
    ...(value.dependencies ? { dependencies: value.dependencies } : {}),
    ...(value.optionalDependencies
      ? { optionalDependencies: value.optionalDependencies }
      : {}),
    bundledDependencies:
      (value.bundledDependencies as string[] | undefined) ?? [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function validateRecipe(recipe: ManagedTypeScriptRecipe): void {
  if (!/^[A-Za-z0-9._-]+$/u.test(recipe.id)) {
    throw new Error("invalid_managed_recipe_id");
  }
  const expectedNames = ["typescript-language-server", "typescript"] as const;
  for (const [index, packageRecipe] of [
    recipe.languageServer,
    recipe.typescript,
  ].entries()) {
    if (packageRecipe.name !== expectedNames[index]) {
      throw new Error("invalid_managed_recipe_package");
    }
    const parsed = new URL(packageRecipe.url);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "registry.npmjs.org" ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error("invalid_managed_recipe_url");
    }
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(packageRecipe.integrity)) {
      throw new Error("invalid_managed_recipe_integrity");
    }
  }
}

function assertAbsoluteDataRoot(dataRoot: string): void {
  if (!path.isAbsolute(dataRoot)) {
    throw new Error("Managed TypeScript dataRoot must be an absolute path");
  }
}

async function assertNotSymbolicLink(target: string): Promise<void> {
  const metadata = await fs.lstat(target);
  if (metadata.isSymbolicLink())
    throw new Error("managed_path_is_symbolic_link");
  if (!metadata.isDirectory()) throw new Error("managed_path_is_not_directory");
}

async function assertRegularFile(target: string): Promise<void> {
  const metadata = await fs.lstat(target);
  if (!metadata.isFile()) throw new Error("managed_path_is_not_regular_file");
}

function assertPathWithin(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("managed_path_escape");
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code);
  }
  return error instanceof Error ? error.message : String(error);
}
