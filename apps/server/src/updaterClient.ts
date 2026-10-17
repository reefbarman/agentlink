import type { AssistantUpdateStatus } from "../../../src/shared/assistantUpdates.js";
import { HttpError } from "./httpJson.js";
import { parseReleaseVersion } from "../../../src/updates/releaseSelection.js";

export interface UpdatePreferences {
  automaticChecks: boolean;
  includePreviews: boolean;
}
export interface UpdateConfirmation {
  version: string;
  expectedInstalledVersion: string;
  confirmed: true;
}
export interface UpdaterClient {
  status(): Promise<AssistantUpdateStatus>;
  check(): Promise<AssistantUpdateStatus>;
  preferences(value: UpdatePreferences): Promise<AssistantUpdateStatus>;
  apply(value: UpdateConfirmation): Promise<AssistantUpdateStatus>;
  rollback(value: UpdateConfirmation): Promise<AssistantUpdateStatus>;
}

export class UpdaterRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "UpdaterRequestError";
  }
}

export function validateUpdateBody(
  action: "check" | "preferences" | "apply" | "rollback",
  body: Record<string, unknown>,
): UpdatePreferences | UpdateConfirmation | Record<string, never> {
  const keys =
    action === "check"
      ? []
      : action === "preferences"
        ? ["automaticChecks", "includePreviews"]
        : ["version", "expectedInstalledVersion", "confirmed"];
  if (
    Object.keys(body).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(body, key))
  ) {
    throw new HttpError(400, "update_request_invalid");
  }
  if (action === "check") return {};
  if (action === "preferences") {
    if (
      typeof body.automaticChecks !== "boolean" ||
      typeof body.includePreviews !== "boolean"
    ) {
      throw new HttpError(400, "update_request_invalid");
    }
    return {
      automaticChecks: body.automaticChecks,
      includePreviews: body.includePreviews,
    };
  }
  if (
    body.confirmed !== true ||
    typeof body.version !== "string" ||
    typeof body.expectedInstalledVersion !== "string" ||
    !parseReleaseVersion(body.version) ||
    !parseReleaseVersion(body.expectedInstalledVersion)
  ) {
    throw new HttpError(400, "update_confirmation_required");
  }
  return {
    version: body.version,
    expectedInstalledVersion: body.expectedInstalledVersion,
    confirmed: true,
  };
}

/** Fixed private service address, never a browser-selected URL. */
export function createUpdaterClient(options: {
  host: string;
  port: number;
  token: string | (() => Promise<string>);
  fetch?: typeof fetch;
}): UpdaterClient {
  if (
    !/^[a-zA-Z0-9.:-]+$/.test(options.host) ||
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  ) {
    throw new Error("updater_address_invalid");
  }
  const host = options.host.includes(":") ? `[${options.host}]` : options.host;
  const base = `http://${host}:${options.port}/v1/updates`;
  const request = options.fetch ?? fetch;
  async function call(
    action?: string,
    value?: unknown,
  ): Promise<AssistantUpdateStatus> {
    try {
      const token =
        typeof options.token === "string"
          ? options.token
          : await options.token();
      if (!token.trim()) throw new Error("empty_token");
      const response = await request(`${base}${action ? `/${action}` : ""}`, {
        method: action ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(action ? { "content-type": "application/json" } : {}),
        },
        ...(action ? { body: JSON.stringify(value ?? {}) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(action ? 30_000 : 5_000),
      });
      const text = await readBoundedResponse(response);
      const body = JSON.parse(text) as {
        status?: AssistantUpdateStatus;
        error?: unknown;
      };
      if (!response.ok) {
        const code =
          typeof body.error === "string" && /^update_[a-z_]+$/.test(body.error)
            ? body.error
            : "update_unavailable";
        throw new UpdaterRequestError(response.status, code);
      }
      if (!body.status || body.status.updaterProtocol !== 1)
        throw new Error("invalid_status");
      return body.status;
    } catch (error) {
      if (error instanceof UpdaterRequestError) throw error;
      throw new UpdaterRequestError(503, "update_unavailable");
    }
  }
  return {
    status: () => call(),
    check: () => call("check", {}),
    preferences: (value) => call("preferences", value),
    apply: (value) => call("apply", value),
    rollback: (value) => call("rollback", value),
  };
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) throw new Error("empty_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 512 * 1024) throw new Error("response_too_large");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
