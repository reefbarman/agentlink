import path from "node:path";

import type { TerminalSurfaceConfiguration } from "@agentlink/protocol/terminal-surface";
import {
  resolveHostShellProfile,
  type HostShellProfileConfiguration,
  type ResolvedHostShellProfile,
} from "./shellProfileResolver.js";

export interface InspectedConfiguration<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

export interface VscodeTerminalConfigurationSnapshot {
  isWorkspaceTrusted: boolean;
  platform: NodeJS.Platform;
  selectedProfileName?: string;
  defaultProfile: InspectedConfiguration<string | null>;
  profiles: InspectedConfiguration<
    Record<string, HostShellProfileConfiguration | null>
  >;
  environment: InspectedConfiguration<Record<string, string | null>>;
  fontFamily?: InspectedConfiguration<string>;
  fontSize?: InspectedConfiguration<number>;
  lineHeight?: InspectedConfiguration<number>;
  letterSpacing?: InspectedConfiguration<number>;
  cursorStyle?: InspectedConfiguration<"block" | "line" | "underline">;
  cursorBlink?: InspectedConfiguration<boolean>;
  scrollback?: InspectedConfiguration<number>;
  baseEnvironment: Record<string, string | undefined>;
  fallbackShellPath: string;
  fallbackShellArgs?: string[];
  activeEditorDirectory?: string;
  workspaceDirectories?: readonly string[];
  homeDirectory: string;
}

export interface AdaptedVscodeTerminalConfiguration {
  profile: ResolvedHostShellProfile;
  terminal: TerminalSurfaceConfiguration;
  ignoredUntrustedWorkspaceConfiguration: boolean;
  warnings: readonly string[];
  nativeFallbackReason?: string;
}

interface VariableContext {
  environment: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  homeDirectory: string;
  workspaceDirectory?: string;
}

interface MaterializedProfileResult {
  profiles: Record<string, HostShellProfileConfiguration | null>;
  unsafeReasonsByProfile: ReadonlyMap<string, readonly string[]>;
}

function scopes<T>(
  inspected: InspectedConfiguration<T> | undefined,
  includeWorkspace: boolean,
): Array<T | undefined> {
  if (!inspected) return [];
  return [
    inspected.defaultValue,
    inspected.globalValue,
    ...(includeWorkspace
      ? [inspected.workspaceValue, inspected.workspaceFolderValue]
      : []),
  ];
}

function selectScalar<T>(
  inspected: InspectedConfiguration<T> | undefined,
  includeWorkspace: boolean,
): T | undefined {
  return scopes(inspected, includeWorkspace).reduce<T | undefined>(
    (selected, value) => (value === undefined ? selected : value),
    undefined,
  );
}

function mergeEnvironmentLayers(
  inspected: InspectedConfiguration<Record<string, string | null>>,
  includeWorkspace: boolean,
): Record<string, string | null> {
  return Object.assign(
    {},
    ...scopes(inspected, includeWorkspace).filter(Boolean),
  );
}

function mergeProfileLayers(
  inspected: InspectedConfiguration<
    Record<string, HostShellProfileConfiguration | null>
  >,
  includeWorkspace: boolean,
): Record<string, HostShellProfileConfiguration | null> {
  const result: Record<string, HostShellProfileConfiguration | null> = {};
  for (const layer of scopes(inspected, includeWorkspace)) {
    for (const [name, profile] of Object.entries(layer ?? {})) {
      if (profile === null) {
        result[name] = null;
        continue;
      }
      const previous = result[name];
      result[name] = {
        ...(previous && previous !== null ? previous : {}),
        ...profile,
        ...(previous && previous !== null && previous.env && profile.env
          ? { env: { ...previous.env, ...profile.env } }
          : {}),
      };
    }
  }
  return result;
}

function chooseCwd(snapshot: VscodeTerminalConfigurationSnapshot): string {
  const candidates = [
    snapshot.activeEditorDirectory,
    ...(snapshot.workspaceDirectories ?? []),
    snapshot.homeDirectory,
  ];
  const cwd = candidates.find(
    (candidate) =>
      candidate !== undefined &&
      candidate.length > 0 &&
      !candidate.includes("\0") &&
      path.isAbsolute(candidate),
  );
  if (!cwd) {
    throw new Error("A local absolute terminal working directory is required");
  }
  return cwd;
}

function materializeString(
  value: string,
  context: VariableContext,
): string | undefined {
  const replaced = value.replace(
    /\$\{(env:([^}]+)|workspaceFolder|userHome|cwd)\}/g,
    (match, token: string, environmentName: string | undefined) => {
      if (token === "workspaceFolder")
        return context.workspaceDirectory ?? match;
      if (token === "userHome") return context.homeDirectory;
      if (token === "cwd") return context.cwd ?? match;
      return context.environment[environmentName ?? ""] ?? match;
    },
  );
  return /\$\{[^}]+\}/.test(replaced) || replaced.includes("\0")
    ? undefined
    : replaced;
}

function materializeProfiles(
  profiles: Record<string, HostShellProfileConfiguration | null>,
  context: VariableContext,
): MaterializedProfileResult {
  const result: Record<string, HostShellProfileConfiguration | null> = {};
  const unsafeReasonsByProfile = new Map<string, readonly string[]>();

  for (const [name, profile] of Object.entries(profiles)) {
    if (profile === null) {
      result[name] = null;
      continue;
    }
    const rawPaths = Array.isArray(profile.path)
      ? profile.path
      : profile.path === undefined
        ? undefined
        : [profile.path];
    const paths = rawPaths?.map((entry) => materializeString(entry, context));
    const rawArgs = Array.isArray(profile.args)
      ? profile.args
      : profile.args === undefined
        ? undefined
        : [profile.args];
    const args = rawArgs?.map((entry) => materializeString(entry, context));
    const environment = Object.fromEntries(
      Object.entries(profile.env ?? {}).map(([key, value]) => [
        key,
        value === null ? null : materializeString(value, context),
      ]),
    );
    const unsafe =
      paths?.some((entry) => entry === undefined) ||
      args?.some((entry) => entry === undefined) ||
      Object.values(environment).some((entry) => entry === undefined);
    const concretePaths = paths?.filter(
      (entry): entry is string => entry !== undefined,
    );
    const relativePath = concretePaths?.find(
      (entry) => !path.isAbsolute(entry),
    );
    if (unsafe || relativePath) {
      unsafeReasonsByProfile.set(name, [
        relativePath
          ? `Terminal profile "${name}" uses a non-absolute executable path.`
          : `Terminal profile "${name}" contains an unsupported or unresolved variable.`,
      ]);
      result[name] = {
        ...profile,
        path: undefined,
        args: undefined,
        env: undefined,
      };
      continue;
    }
    result[name] = {
      ...profile,
      ...(paths
        ? { path: Array.isArray(profile.path) ? (paths as string[]) : paths[0] }
        : {}),
      ...(args
        ? { args: Array.isArray(profile.args) ? (args as string[]) : args[0] }
        : {}),
      ...(profile.env
        ? { env: environment as Record<string, string | null> }
        : {}),
    };
  }
  return { profiles: result, unsafeReasonsByProfile };
}

function materializeEnvironment(
  environment: Record<string, string | null>,
  context: VariableContext,
): { environment: Record<string, string | null>; unsafeReasons: string[] } {
  const result: Record<string, string | null> = {};
  const unsafeReasons: string[] = [];
  for (const [name, value] of Object.entries(environment)) {
    if (value === null) {
      result[name] = null;
      continue;
    }
    const materialized = materializeString(value, context);
    if (materialized === undefined) {
      unsafeReasons.push(
        `Terminal environment variable "${name}" contains an unsupported or unresolved variable.`,
      );
    } else {
      result[name] = materialized;
    }
  }
  return { environment: result, unsafeReasons };
}

function positiveNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function nonNegativeNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function adaptVscodeTerminalConfiguration(
  snapshot: VscodeTerminalConfigurationSnapshot,
): AdaptedVscodeTerminalConfiguration {
  const includeExecutionWorkspace = snapshot.isWorkspaceTrusted;
  const cwd = chooseCwd(snapshot);
  const workspaceDirectory = includeExecutionWorkspace
    ? snapshot.workspaceDirectories?.find(
        (candidate) =>
          candidate.length > 0 &&
          !candidate.includes("\0") &&
          path.isAbsolute(candidate),
      )
    : undefined;
  const variableContext: VariableContext = {
    environment: snapshot.baseEnvironment,
    ...(includeExecutionWorkspace ? { cwd } : {}),
    homeDirectory: snapshot.homeDirectory,
    workspaceDirectory,
  };
  const materializedProfiles = materializeProfiles(
    mergeProfileLayers(snapshot.profiles, includeExecutionWorkspace),
    variableContext,
  );
  const materializedEnvironment = materializeEnvironment(
    mergeEnvironmentLayers(snapshot.environment, includeExecutionWorkspace),
    variableContext,
  );
  const defaultProfileName =
    snapshot.selectedProfileName ??
    selectScalar(snapshot.defaultProfile, includeExecutionWorkspace);
  const profile = resolveHostShellProfile({
    platform: snapshot.platform,
    defaultProfileName,
    profiles: materializedProfiles.profiles,
    platformEnvironment: materializedEnvironment.environment,
    baseEnvironment: snapshot.baseEnvironment,
    fallbackShellPath: snapshot.fallbackShellPath,
    fallbackShellArgs: snapshot.fallbackShellArgs,
    cwd,
  });
  const selectedProfileName = defaultProfileName?.trim();
  const selectedProfile = selectedProfileName
    ? materializedProfiles.profiles[selectedProfileName]
    : undefined;
  const selectedProfileUnsafeReasons = selectedProfileName
    ? [
        ...(materializedProfiles.unsafeReasonsByProfile.get(
          selectedProfileName,
        ) ?? []),
      ]
    : [];
  const selectedProfileUnresolved =
    selectedProfileName !== undefined &&
    (selectedProfile === undefined ||
      selectedProfile === null ||
      selectedProfile.path === undefined ||
      (Array.isArray(selectedProfile.path) &&
        selectedProfile.path.every((entry) => entry.trim().length === 0)) ||
      (!Array.isArray(selectedProfile.path) &&
        selectedProfile.path.trim().length === 0));
  const warnings = [
    ...(includeExecutionWorkspace
      ? []
      : [
          "Workspace terminal executable, argument, and environment overrides were ignored because the workspace is not trusted.",
        ]),
    ...selectedProfileUnsafeReasons,
    ...materializedEnvironment.unsafeReasons,
    ...(profile.warning ? [profile.warning] : []),
  ];
  const nativeFallbackReasons = [
    ...selectedProfileUnsafeReasons,
    ...materializedEnvironment.unsafeReasons,
    ...(selectedProfileUnresolved && profile.warning ? [profile.warning] : []),
  ];

  return {
    profile,
    terminal: {
      ...(selectScalar(snapshot.fontFamily, true)?.trim()
        ? { fontFamily: selectScalar(snapshot.fontFamily, true)!.trim() }
        : {}),
      ...(positiveNumber(selectScalar(snapshot.fontSize, true)) !== undefined
        ? { fontSize: positiveNumber(selectScalar(snapshot.fontSize, true)) }
        : {}),
      ...(positiveNumber(selectScalar(snapshot.lineHeight, true)) !== undefined
        ? {
            lineHeight: positiveNumber(selectScalar(snapshot.lineHeight, true)),
          }
        : {}),
      ...(nonNegativeNumber(selectScalar(snapshot.letterSpacing, true)) !==
      undefined
        ? {
            letterSpacing: nonNegativeNumber(
              selectScalar(snapshot.letterSpacing, true),
            ),
          }
        : {}),
      ...(selectScalar(snapshot.cursorStyle, true)
        ? { cursorStyle: selectScalar(snapshot.cursorStyle, true) }
        : {}),
      ...(selectScalar(snapshot.cursorBlink, true) !== undefined
        ? { cursorBlink: selectScalar(snapshot.cursorBlink, true) }
        : {}),
      scrollback: Math.floor(
        positiveNumber(selectScalar(snapshot.scrollback, true)) ?? 1000,
      ),
    },
    ignoredUntrustedWorkspaceConfiguration: !includeExecutionWorkspace,
    warnings,
    ...(nativeFallbackReasons.length > 0
      ? {
          nativeFallbackReason:
            "Terminal configuration contains values that cannot be materialized safely for the custom terminal.",
        }
      : {}),
  };
}
