/**
 * Which build of the server bundle this is. Every AgentLink service in a
 * deployment (assistant, command worker, publisher, backup sidecar, runner
 * manager, session runners) runs the same bundle, so they should all report
 * the same build; a different one means an image was not rebuilt.
 */

export interface ServerBuild {
  /** The server package's version. */
  readonly version: string;
  /** The source commit, when the build knew it. */
  readonly commit?: string;
  /** Unique per bundle build: the same ID means the same bundle. */
  readonly id: string;
}

/**
 * Replaced at bundle time by esbuild.mjs. Undefined when running from
 * source (tests), which reports a `dev` build.
 */
declare const __AGENTLINK_SERVER_BUILD__: ServerBuild | undefined;

export const SERVER_BUILD: ServerBuild =
  typeof __AGENTLINK_SERVER_BUILD__ === "undefined"
    ? { version: "dev", id: "dev" }
    : __AGENTLINK_SERVER_BUILD__;

/** "0.1.0 (ca02d7df)", or "0.1.0" without a commit. */
export function describeBuild(build: ServerBuild | undefined): string {
  if (!build) return "an older version";
  return build.commit ? `${build.version} (${build.commit})` : build.version;
}

/** A build reported on a ping, if it is well-formed. */
export function parseBuild(value: unknown): ServerBuild | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.version !== "string" || typeof record.id !== "string") {
    return undefined;
  }
  return {
    version: record.version,
    id: record.id,
    ...(typeof record.commit === "string" ? { commit: record.commit } : {}),
  };
}

/** One internal service as seen from the assistant. */
export interface ServiceVersion {
  /** For messages: "command worker", "publisher", ... */
  readonly name: string;
  /** Undefined when it did not answer. */
  readonly reachable: boolean;
  readonly error?: string;
  readonly build?: ServerBuild;
  readonly protocol?: number;
  /** The protocol this server speaks to it. */
  readonly expectedProtocol?: number;
}

/**
 * What is wrong with the services' versions, in plain words: unreachable
 * services, protocol mismatches, and builds other than this one. Empty when
 * everything matches. Development builds (from source) skip the build
 * comparison.
 */
export function versionProblems(
  self: ServerBuild,
  services: readonly ServiceVersion[],
): string[] {
  const problems: string[] = [];
  for (const service of services) {
    if (!service.reachable) {
      problems.push(
        `${service.name} is not reachable${service.error ? ` (${service.error})` : ""}`,
      );
      continue;
    }
    if (
      service.expectedProtocol !== undefined &&
      service.protocol !== undefined &&
      service.protocol !== service.expectedProtocol
    ) {
      problems.push(
        `${service.name} speaks protocol ${service.protocol}, the assistant ${service.expectedProtocol}: rebuild both`,
      );
      continue;
    }
    if (self.id === "dev") continue;
    if (!service.build) {
      problems.push(
        `${service.name} reports no version, so it is older than the assistant (${describeBuild(self)}): rebuild both`,
      );
    } else if (service.build.id !== self.id) {
      problems.push(
        `${service.name} is version ${describeBuild(service.build)}, the assistant is ${describeBuild(self)}: rebuild both`,
      );
    }
  }
  return problems;
}
