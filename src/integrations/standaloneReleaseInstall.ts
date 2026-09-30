import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const repository = "https://github.com/reefbarman/agentlink";

export type StandaloneProduct = "desktop" | "cli";

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface StandaloneRelease {
  tag_name: string;
  draft: boolean;
  assets: ReleaseAsset[];
}

export function selectStandaloneRelease(
  releases: StandaloneRelease[],
  product: StandaloneProduct,
  arch: string,
): { tag: string; asset: ReleaseAsset; checksum?: ReleaseAsset } | undefined {
  for (const release of releases) {
    const match = new RegExp(`^${product}-v(\\d+\\.\\d+\\.\\d+)$`).exec(
      release.tag_name,
    );
    if (release.draft || !match) continue;
    const name =
      product === "desktop"
        ? `AgentLink-Desktop-${match[1]}-mac-${arch}.dmg`
        : `agentlink-cli-darwin-${arch}-v${match[1]}.tar.gz`;
    const asset = release.assets.find((entry) => entry.name === name);
    const checksum = release.assets.find(
      (entry) => entry.name === `${name}.sha256`,
    );
    if (!asset || (product === "cli" && !checksum)) continue;
    for (const entry of [asset, checksum]) {
      if (
        entry &&
        entry.browser_download_url !==
          `${repository}/releases/download/${release.tag_name}/${entry.name}`
      ) {
        throw new Error("Release asset has an unexpected download URL.");
      }
    }
    return { tag: release.tag_name, asset, checksum };
  }
  return undefined;
}

export async function findStandaloneRelease(
  product: StandaloneProduct,
  arch: string,
) {
  // Desktop and CLI use separate prerelease tags, not releases/latest.
  for (let page = 1; page <= 10; page++) {
    const { stdout } = await runFile(
      "/usr/bin/curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--max-time",
        "30",
        "--header",
        "Accept: application/vnd.github+json",
        `https://api.github.com/repos/reefbarman/agentlink/releases?per_page=100&page=${page}`,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const releases: StandaloneRelease[] = JSON.parse(stdout);
    const selected = selectStandaloneRelease(releases, product, arch);
    if (selected) return selected;
    if (releases.length < 100) break;
  }
  throw new Error(`No published ${product} release is available for ${arch}.`);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildCliInstallCommand(
  release: NonNullable<ReturnType<typeof selectStandaloneRelease>>,
): string {
  if (!release.checksum)
    throw new Error("CLI release is missing its checksum.");
  if (
    !/^agentlink-cli-darwin-arm64-v\d+\.\d+\.\d+\.tar\.gz$/.test(
      release.asset.name,
    )
  ) {
    throw new Error(
      "CLI installation supports macOS Apple Silicon releases only.",
    );
  }
  const archive = quote(release.asset.name);
  return `(
set -eu
bin="$HOME/.local/bin"
lib="$HOME/.local/lib/agentlink"
if [ -e "$bin/agentlink" ] || [ -L "$bin/agentlink" ]; then
  printf '%s\\n' "An agentlink command already exists at $bin/agentlink. No files were replaced."
  exit 1
fi
mkdir -p "$bin" "$lib"
stage=$(mktemp -d "$lib/cli-preview.XXXXXX")
trap 'rm -rf "$stage"' EXIT
cd "$stage"
curl --fail --location --show-error --proto '=https' --proto-redir '=https' --connect-timeout 30 --max-time 600 -o ${archive} ${quote(release.asset.browser_download_url)}
curl --fail --location --show-error --proto '=https' --proto-redir '=https' --connect-timeout 30 --max-time 60 -o checksum.sha256 ${quote(release.checksum.browser_download_url)}
expected=$(awk 'NR == 1 {print $1}' checksum.sha256)
if ! printf '%s\\n' "$expected" | /usr/bin/grep -Eq '^[0-9a-fA-F]{64}$'; then
  printf '%s\\n' 'Invalid release checksum.'
  exit 1
fi
printf '%s  %s\\n' "$expected" ${archive} | shasum -a 256 -c -
tar -xzf ${archive}
test -x "$stage/agentlink-cli-darwin-arm64/bin/agentlink"
ln -s "$stage/agentlink-cli-darwin-arm64/bin/agentlink" "$bin/agentlink"
trap - EXIT
rm ${archive} checksum.sha256
printf '%s\\n' "Installed ${release.tag} at $bin/agentlink" 'Add ~/.local/bin to PATH if needed, then run agentlink --help.' 'This preview is unsigned and not notarised. macOS may block its first launch.'
)`;
}
