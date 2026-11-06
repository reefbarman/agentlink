import type { ResponsesWebSocketConnector } from "./responsesTransport.js";

/** Public client identity only. Never add credentials, IDs, or routing state. */
export interface CodexRequestIdentityDiagnostics {
  transport: "http" | "websocket";
  originator: string | null;
  userAgent: string | null;
  version: string | null;
  openAIBeta: string | null;
  responsesLite: string | null;
}

export type CodexRequestIdentityObserver = (
  diagnostics: CodexRequestIdentityDiagnostics,
) => void;

function reportIdentity(
  transport: CodexRequestIdentityDiagnostics["transport"],
  headers: ConstructorParameters<typeof Headers>[0],
  observer: CodexRequestIdentityObserver,
): void {
  try {
    const values = new Headers(headers);
    const read = (name: string): string | null => {
      const value = values.get(name);
      return value && value.length > 512
        ? `${value.slice(0, 512)}[truncated]`
        : value;
    };
    // Explicit projection, not a filtered header dump. Keep this list narrow.
    observer({
      transport,
      originator: read("originator"),
      userAgent: read("user-agent"),
      version: read("version"),
      openAIBeta: read("openai-beta"),
      responsesLite: read("x-openai-internal-codex-responses-lite"),
    });
  } catch {
    // Diagnostics must never prevent or retry a provider request.
  }
}

/** Observe final SDK headers without reading the body or changing fetch inputs. */
export function createCodexIdentityDiagnosticFetch(
  fetch: typeof globalThis.fetch,
  observer: CodexRequestIdentityObserver,
): typeof globalThis.fetch {
  return (input, init) => {
    reportIdentity(
      "http",
      init?.headers ??
        (typeof input === "object" && "headers" in input
          ? input.headers
          : undefined),
      observer,
    );
    return fetch(input, init);
  };
}

/** Observe actual handshake headers, including model-specific protocol flags. */
export function createCodexIdentityDiagnosticConnector(
  connector: ResponsesWebSocketConnector,
  observer: CodexRequestIdentityObserver,
): ResponsesWebSocketConnector {
  return {
    connect: (request) => {
      reportIdentity("websocket", request.headers, observer);
      return connector.connect(request);
    },
  };
}
