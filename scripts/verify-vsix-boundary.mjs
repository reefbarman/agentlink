import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";

const FORBIDDEN_DESKTOP_PATTERNS = [
  /^apps\/desktop(?:\/|$)/u,
  /^desktop-releases(?:\/|$)/u,
  /^dist\/desktop(?:\/|$)/u,
  /(?:^|\/)electron(?:\.app|\.exe)?(?:\/|$)/iu,
  /(?:^|\/)main\.cjs$/u,
  /(?:^|\/)chat-preload\.cjs$/u,
  /(?:^|\/)preload\.cjs$/u,
];

function normalizePath(value) {
  return value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^extension\//u, "");
}

export function verifyVsixManifestExcludesDesktop(manifest) {
  if (manifest.dependencies?.["@agentlink/desktop"] !== undefined) {
    throw new Error(
      "VSIX manifest must not declare @agentlink/desktop as a production dependency",
    );
  }
  return { productionDesktopDependency: false };
}

export function verifyVsixExcludesDesktop(fileList) {
  const files = fileList.split(/\r?\n/u).map(normalizePath).filter(Boolean);
  const forbidden = files.filter((file) =>
    FORBIDDEN_DESKTOP_PATTERNS.some((pattern) => pattern.test(file)),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `VSIX contains standalone desktop payloads: ${forbidden.join(", ")}`,
    );
  }
  return { fileCount: files.length, forbiddenDesktopPaths: [] };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--list") options.listPath = argv[++index];
    else if (argument === "--manifest") options.manifestPath = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.listPath) throw new Error("--list is required");
  return options;
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const options = parseArguments(process.argv.slice(2));
  const inventory = verifyVsixExcludesDesktop(
    await readFile(options.listPath, "utf8"),
  );
  const manifest = verifyVsixManifestExcludesDesktop(
    JSON.parse(
      await readFile(
        options.manifestPath ?? path.resolve("package.json"),
        "utf8",
      ),
    ),
  );
  process.stdout.write(
    `${JSON.stringify({ ...inventory, ...manifest }, null, 2)}\n`,
  );
}
