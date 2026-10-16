import {
  isCoreReasoningEffort,
  type CoreReasoningEffort,
} from "@agentlink/protocol";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "./atomicFile.js";
import {
  DEFAULT_NETWORK_POLICY,
  isNetworkPreset,
  normalizeNetworkAllow,
  type NetworkPolicy,
} from "./egressPolicy.js";
import { HttpError } from "./httpJson.js";
import type { AssistantServerProjectConfig } from "./serverConfig.js";

/**
 * The projects the chat app offers: the ones in the configuration plus the
 * ones created from the app, each with its own settings. Created projects
 * are folders under `projectsRoot`, empty or holding one or more cloned
 * repositories side by side. The catalog is kept in one JSON file.
 */

export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const MAX_LABEL_LENGTH = 80;
const MAX_REPOSITORIES = 10;
const MAX_URL_LENGTH = 2_048;
const DIRECTORY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/u;

export interface AssistantProjectRepository {
  /** `https://` clone URL, without credentials. */
  readonly url: string;
  /** Folder inside the project the repository was cloned into. */
  readonly directory: string;
}

export interface AssistantProjectSettings {
  /** `providerId/modelId` new chats start with. */
  readonly defaultModel?: string;
  readonly defaultReasoningEffort?: CoreReasoningEffort;
  /** Network access for commands and web tools; absent means open web. */
  readonly network?: NetworkPolicy;
}

/** A project's effective network policy. */
export function projectNetworkPolicy(
  entry: Pick<AssistantProjectEntry, "settings"> | undefined,
): NetworkPolicy {
  return entry?.settings.network ?? DEFAULT_NETWORK_POLICY;
}

export interface AssistantProjectEntry {
  readonly id: string;
  readonly label: string;
  readonly root: string;
  /** `config` projects come from server.json; `app` ones were created here. */
  readonly origin: "config" | "app";
  readonly repositories: readonly AssistantProjectRepository[];
  readonly createdAt?: number;
  readonly settings: AssistantProjectSettings;
}

export interface CreateAssistantProjectRequest {
  readonly label: string;
  /** Clone URLs; empty for an empty project. */
  readonly repositories: readonly string[];
}

export interface AssistantProjectSettingsPatch {
  readonly label?: string;
  /** `null` clears the setting. */
  readonly defaultModel?: string | null;
  readonly defaultReasoningEffort?: CoreReasoningEffort | null;
  readonly network?: {
    readonly preset: unknown;
    readonly allow?: readonly unknown[];
  };
}

/** Validate a network settings patch from the app. */
export function parseNetworkPatch(value: {
  readonly preset: unknown;
  readonly allow?: readonly unknown[];
}): NetworkPolicy {
  if (!isNetworkPreset(value.preset)) {
    throw new ProjectSettingsError("network_preset_invalid");
  }
  const allow = value.allow ?? [];
  if (!allow.every((entry) => typeof entry === "string")) {
    throw new ProjectSettingsError("network_allow_invalid");
  }
  try {
    return {
      preset: value.preset,
      allow: normalizeNetworkAllow(allow as string[]),
    };
  } catch (error) {
    throw new ProjectSettingsError(
      "network_allow_invalid",
      error instanceof Error ? error.message : undefined,
    );
  }
}

/** A rejected setting, with a detail the app can show. */
export class ProjectSettingsError extends HttpError {
  constructor(
    code: string,
    readonly detail?: string,
  ) {
    super(400, code);
  }
}

/** Clone one repository into `directory` inside `cwd`; throws on failure. */
export type CloneRepository = (request: {
  readonly url: string;
  readonly directory: string;
  /** Canonical absolute project folder. */
  readonly cwd: string;
}) => Promise<void>;

export interface ProjectCatalog {
  list(): AssistantProjectEntry[];
  get(projectId: string): AssistantProjectEntry | undefined;
  /** Whether projects can be created (a `projectsRoot` is configured). */
  readonly canCreate: boolean;
  /**
   * Create the folder, clone each repository, then record the project. On
   * any failure the folder is removed and nothing is recorded.
   */
  create(
    request: CreateAssistantProjectRequest,
    clone: CloneRepository,
  ): Promise<AssistantProjectEntry>;
  update(
    projectId: string,
    patch: AssistantProjectSettingsPatch,
  ): Promise<AssistantProjectEntry>;
}

export interface OpenProjectCatalogOptions {
  readonly file: string;
  readonly configProjects: readonly AssistantServerProjectConfig[];
  readonly projectsRoot?: string;
  readonly now?: () => number;
}

interface StoredProject {
  readonly id: string;
  readonly label: string;
  readonly root: string;
  readonly repositories: AssistantProjectRepository[];
  readonly createdAt: number;
}

interface StoredCatalog {
  created: StoredProject[];
  settings: Record<string, StoredSettings>;
}

interface StoredSettings {
  label?: string;
  defaultModel?: string;
  defaultReasoningEffort?: CoreReasoningEffort;
  network?: NetworkPolicy;
}

export class ProjectCloneError extends HttpError {
  constructor(
    readonly url: string,
    readonly detail: string,
  ) {
    super(422, "project_clone_failed");
  }
}

export async function openProjectCatalog(
  options: OpenProjectCatalogOptions,
): Promise<ProjectCatalog> {
  const now = options.now ?? Date.now;
  const stored = await readCatalog(options.file);
  const configIds = new Set(
    options.configProjects.map((project) => project.id),
  );
  // A created project whose ID is now in server.json yields to the config.
  stored.created = stored.created.filter(
    (project) => !configIds.has(project.id),
  );
  /** IDs being created right now, so two requests cannot race to one ID. */
  const reserved = new Set<string>();
  let write: Promise<void> = Promise.resolve();

  const save = () => {
    const snapshot = JSON.stringify({ version: 1, ...stored }, null, 2);
    write = write
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(options.file), {
          recursive: true,
          mode: 0o700,
        });
        await writeFileAtomic(options.file, snapshot);
      });
    return write;
  };

  const entryFor = (
    base: Omit<AssistantProjectEntry, "settings" | "label"> & {
      readonly label: string;
    },
  ): AssistantProjectEntry => {
    const settings = stored.settings[base.id] ?? {};
    return {
      ...base,
      label: settings.label ?? base.label,
      settings: {
        ...(settings.defaultModel
          ? { defaultModel: settings.defaultModel }
          : {}),
        ...(settings.defaultReasoningEffort
          ? { defaultReasoningEffort: settings.defaultReasoningEffort }
          : {}),
        ...(settings.network ? { network: settings.network } : {}),
      },
    };
  };

  const list = (): AssistantProjectEntry[] => [
    ...options.configProjects.map((project) =>
      entryFor({
        id: project.id,
        label: project.label ?? project.id,
        root: project.root,
        origin: "config",
        repositories: [],
      }),
    ),
    ...stored.created.map((project) =>
      entryFor({
        id: project.id,
        label: project.label,
        root: project.root,
        origin: "app",
        repositories: project.repositories,
        createdAt: project.createdAt,
      }),
    ),
  ];
  const get = (projectId: string) =>
    list().find((project) => project.id === projectId);

  return {
    list,
    get,
    canCreate: options.projectsRoot !== undefined,
    async create(request, clone) {
      const projectsRoot = options.projectsRoot;
      if (!projectsRoot) throw new HttpError(409, "project_creation_disabled");
      const label = normalizeLabel(request.label);
      const repositories = planRepositories(request.repositories);
      const isTaken = (candidate: string) =>
        reserved.has(candidate) ||
        list().some((project) => project.id === candidate);
      const id = await uniqueProjectId(label, isTaken, projectsRoot);
      // Synchronously after the last check, so no other request takes it.
      reserved.add(id);
      const root = path.join(projectsRoot, id);
      try {
        // Not recursive: the folder must not exist yet.
        await fs.mkdir(projectsRoot, { recursive: true });
        await fs.mkdir(root, { mode: 0o755 });
        try {
          const cwd = await fs.realpath(root);
          for (const repository of repositories) {
            await clone({ ...repository, cwd });
          }
        } catch (error) {
          await fs.rm(root, { recursive: true, force: true });
          throw error;
        }
        stored.created.push({
          id,
          label,
          root,
          repositories,
          createdAt: now(),
        });
        await save();
        return get(id)!;
      } finally {
        reserved.delete(id);
      }
    },
    async update(projectId, patch) {
      if (!get(projectId)) throw new HttpError(404, "project_not_found");
      const current: StoredSettings = { ...stored.settings[projectId] };
      if (patch.label !== undefined)
        current.label = normalizeLabel(patch.label);
      if (patch.defaultModel === null) delete current.defaultModel;
      else if (patch.defaultModel !== undefined) {
        current.defaultModel = patch.defaultModel;
      }
      if (patch.defaultReasoningEffort === null) {
        delete current.defaultReasoningEffort;
      } else if (patch.defaultReasoningEffort !== undefined) {
        current.defaultReasoningEffort = patch.defaultReasoningEffort;
      }
      if (patch.network !== undefined) {
        current.network = parseNetworkPatch(patch.network);
      }
      stored.settings[projectId] = current;
      await save();
      return get(projectId)!;
    },
  };
}

export function normalizeLabel(value: string): string {
  const label = value.replace(/\s+/gu, " ").trim();
  if (!label) throw new HttpError(400, "project_name_required");
  if (label.length > MAX_LABEL_LENGTH) {
    throw new HttpError(400, "project_name_too_long");
  }
  return label;
}

/** Validate clone URLs and give each a distinct folder name. */
export function planRepositories(
  urls: readonly string[],
): AssistantProjectRepository[] {
  if (urls.length > MAX_REPOSITORIES) {
    throw new HttpError(400, "too_many_repositories");
  }
  const used = new Set<string>();
  return urls.map((raw) => {
    const url = raw.trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpError(400, "repository_url_invalid");
    }
    if (
      url.length > MAX_URL_LENGTH ||
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      // Credentials would be stored in the catalog and the clone's config.
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new HttpError(400, "repository_url_invalid");
    }
    const base = repositoryDirectory(parsed);
    let directory = base;
    for (let suffix = 2; used.has(directory.toLowerCase()); suffix += 1) {
      directory = `${base}-${suffix}`;
    }
    used.add(directory.toLowerCase());
    return { url: parsed.href, directory };
  });
}

function repositoryDirectory(url: URL): string {
  const last =
    url.pathname
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.replace(/\.git$/iu, "") ?? "";
  const cleaned = last
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[.-]+/u, "")
    .slice(0, 100);
  return DIRECTORY_PATTERN.test(cleaned) ? cleaned : "repository";
}

export function slugifyProjectId(label: string): string {
  const slug = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/u, "");
  return PROJECT_ID_PATTERN.test(slug) ? slug : "project";
}

async function uniqueProjectId(
  label: string,
  isTaken: (id: string) => boolean,
  projectsRoot: string,
): Promise<string> {
  const base = slugifyProjectId(label);
  for (let suffix = 1; suffix < 1_000; suffix += 1) {
    const id = suffix === 1 ? base : `${base}-${suffix}`;
    if (isTaken(id)) continue;
    // A leftover folder (for example from a removed project) is kept.
    const exists = await fs
      .lstat(path.join(projectsRoot, id))
      .then(() => true)
      .catch(() => false);
    // Checked again: another request may have reserved it meanwhile.
    if (!exists && !isTaken(id)) return id;
  }
  throw new HttpError(409, "project_id_unavailable");
}

async function readCatalog(file: string): Promise<StoredCatalog> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { created: [], settings: {} };
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as {
    version?: unknown;
    created?: unknown;
    settings?: unknown;
  };
  if (parsed.version !== 1) {
    throw new Error(`Unsupported project catalog: ${file}`);
  }
  const created: StoredProject[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(parsed.created) ? parsed.created : []) {
    const project = readStoredProject(item);
    if (project && !seen.has(project.id)) {
      seen.add(project.id);
      created.push(project);
    }
  }
  const settings: Record<string, StoredSettings> = {};
  if (parsed.settings && typeof parsed.settings === "object") {
    for (const [id, value] of Object.entries(parsed.settings)) {
      if (!PROJECT_ID_PATTERN.test(id) || !value || typeof value !== "object") {
        continue;
      }
      const record = value as Record<string, unknown>;
      settings[id] = {
        ...(typeof record.label === "string" && record.label.trim()
          ? { label: record.label }
          : {}),
        ...(typeof record.defaultModel === "string"
          ? { defaultModel: record.defaultModel }
          : {}),
        ...(typeof record.defaultReasoningEffort === "string" &&
        isCoreReasoningEffort(record.defaultReasoningEffort)
          ? { defaultReasoningEffort: record.defaultReasoningEffort }
          : {}),
        ...readStoredNetwork(record.network),
      };
    }
  }
  return { created, settings };
}

/** A stored policy, or nothing (open web) if it no longer validates. */
function readStoredNetwork(value: unknown): { network?: NetworkPolicy } {
  if (!value || typeof value !== "object") return {};
  const { preset, allow } = value as Record<string, unknown>;
  try {
    return {
      network: parseNetworkPatch({
        preset,
        allow: Array.isArray(allow) ? allow : [],
      }),
    };
  } catch {
    // Fail closed: a damaged entry must not widen access.
    return { network: { preset: "off", allow: [] } };
  }
}

function readStoredProject(value: unknown): StoredProject | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !PROJECT_ID_PATTERN.test(record.id) ||
    typeof record.label !== "string" ||
    typeof record.root !== "string" ||
    !path.isAbsolute(record.root)
  ) {
    return undefined;
  }
  const repositories = Array.isArray(record.repositories)
    ? record.repositories.flatMap((item): AssistantProjectRepository[] => {
        if (!item || typeof item !== "object") return [];
        const { url, directory } = item as Record<string, unknown>;
        return typeof url === "string" && typeof directory === "string"
          ? [{ url, directory }]
          : [];
      })
    : [];
  return {
    id: record.id,
    label: record.label,
    root: record.root,
    repositories,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
  };
}
