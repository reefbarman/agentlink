import {
  RELEASE_REPOSITORY_URL,
  RELEASE_UPDATE_METADATA_NAME,
  type ReleaseUpdateIdentity,
} from "./releaseUpdateTypes.js";
import {
  compareReleaseVersions,
  compatibleRelease,
  parseReleaseUpdateMetadata,
  releaseVersionFromTag,
  selectReleaseUpdate,
  type ValidatedReleaseRecord,
} from "./releaseSelection.js";

export interface ReleaseDiscovery {
  records: ValidatedReleaseRecord[];
  unverifiedVersions: string[];
  complete: boolean;
}

export class ReleaseRateLimitError extends Error {
  constructor(readonly retryAt: number) {
    super("release_rate_limited");
  }
}

interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: { name: string; browser_download_url: string }[];
}

const api = "https://api.github.com/repos/reefbarman/agentlink/releases";
const redirectHosts = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

class ReleaseRequestBudgetError extends Error {}

export class GithubReleaseClient {
  private readonly responses = new Map<
    string,
    { etag: string; value: unknown }
  >();
  constructor(
    private readonly request: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async discover(
    identity: ReleaseUpdateIdentity,
    signal: AbortSignal,
  ): Promise<ReleaseDiscovery> {
    const result: ReleaseDiscovery = {
      records: [],
      unverifiedVersions: [],
      complete: false,
    };
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    let requests = 0;
    const read = async (url: string, limit: number): Promise<unknown> =>
      this.readJson(url, limit, deadline, () => {
        if (++requests > 10) throw new ReleaseRequestBudgetError();
      });
    let compatibleVersion: string | undefined;
    try {
      for (let page = 1; page <= 10 && requests < 10; page++) {
        const listing = await read(
          `${api}?per_page=100&page=${page}`,
          4 * 1024 * 1024,
        );
        if (
          !Array.isArray(listing) ||
          listing.length > 100 ||
          !listing.every(isGithubRelease)
        )
          throw new Error("invalid_release_listing");
        const releases = listing
          .filter(isGithubRelease)
          .filter((release) => {
            return (
              !release.draft &&
              release.published_at &&
              releaseVersionFromTag(release.tag_name, identity.product) &&
              (identity.product !== "vscode" || !release.prerelease)
            );
          })
          .sort((left, right) =>
            compareReleaseVersions(
              releaseVersionFromTag(right.tag_name, identity.product)!,
              releaseVersionFromTag(left.tag_name, identity.product)!,
            ),
          );
        for (const release of releases) {
          const version = releaseVersionFromTag(
            release.tag_name,
            identity.product,
          )!;
          if (
            compatibleVersion &&
            compareReleaseVersions(version, compatibleVersion) <= 0
          )
            continue;
          const metadataAsset = release.assets.find(
            (asset) => asset.name === RELEASE_UPDATE_METADATA_NAME,
          );
          if (!metadataAsset) {
            result.unverifiedVersions.push(version);
            continue;
          }
          if (requests >= 10) return result;
          const expected = `${RELEASE_REPOSITORY_URL}/releases/download/${release.tag_name}/${RELEASE_UPDATE_METADATA_NAME}`;
          if (metadataAsset.browser_download_url !== expected) {
            result.unverifiedVersions.push(version);
            continue;
          }
          const metadata = parseReleaseUpdateMetadata(
            await read(expected, 64 * 1024),
            identity.product,
            release.tag_name,
          );
          if (
            !metadata ||
            metadata.channel !== (release.prerelease ? "preview" : "stable")
          ) {
            result.unverifiedVersions.push(version);
            continue;
          }
          const assets = release.assets
            .filter(
              (asset) =>
                asset.browser_download_url ===
                `${RELEASE_REPOSITORY_URL}/releases/download/${release.tag_name}/${asset.name}`,
            )
            .map((asset) => asset.name);
          const record = { metadata, assets, prerelease: release.prerelease };
          result.records.push(record);
          if (compatibleRelease(record, identity)) compatibleVersion = version;
          if (selectReleaseUpdate(result.records, identity)) return result;
        }
        if (listing.length < 100) {
          result.complete = true;
          return result;
        }
      }
    } catch (error) {
      if (!(error instanceof ReleaseRequestBudgetError)) throw error;
    }
    return result;
  }

  private async readJson(
    url: string,
    limit: number,
    signal: AbortSignal,
    beforeRequest: () => void,
  ): Promise<unknown> {
    const cached = this.responses.get(url);
    let currentUrl = url;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const parsed = new URL(currentUrl);
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.port ||
        !(
          parsed.hostname === "api.github.com" ||
          redirectHosts.has(parsed.hostname)
        )
      )
        throw new Error("invalid_release_url");
      beforeRequest();
      const response = await this.request(currentUrl, {
        signal,
        redirect: "manual",
        headers: {
          Accept:
            parsed.hostname === "api.github.com"
              ? "application/vnd.github+json"
              : "application/json",
          ...(cached && currentUrl === url
            ? { "If-None-Match": cached.etag }
            : {}),
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error("invalid_release_redirect");
        currentUrl = new URL(location, currentUrl).href;
        continue;
      }
      if (response.status === 304 && cached) return cached.value;
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" ||
            response.headers.has("retry-after")))
      ) {
        await response.body?.cancel();
        const retryAfter = Number(response.headers.get("retry-after"));
        const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
        throw new ReleaseRateLimitError(
          Math.max(
            Date.now() +
              (Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : 60_000),
            Number.isFinite(reset) ? reset : 0,
          ),
        );
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("release_metadata_unavailable");
      }
      if (Number(response.headers.get("content-length")) > limit) {
        await response.body.cancel();
        throw new Error("release_response_too_large");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > limit) throw new Error("release_response_too_large");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      const etag = response.headers.get("etag");
      if (etag) {
        if (this.responses.size >= 20)
          this.responses.delete(this.responses.keys().next().value!);
        this.responses.set(url, { etag, value });
      }
      return value;
    }
    throw new Error("release_redirect_limit");
  }
}

function isGithubRelease(value: unknown): value is GithubRelease {
  if (!value || typeof value !== "object") return false;
  const release = value as GithubRelease;
  return (
    typeof release.tag_name === "string" &&
    typeof release.draft === "boolean" &&
    typeof release.prerelease === "boolean" &&
    (release.published_at === null ||
      typeof release.published_at === "string") &&
    Array.isArray(release.assets) &&
    release.assets.length <= 100 &&
    release.assets.every(
      (asset) =>
        asset &&
        typeof asset.name === "string" &&
        typeof asset.browser_download_url === "string",
    )
  );
}
