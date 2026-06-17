export interface McpUrlElicitationRequest {
  id: string;
  serverName: string;
  message: string;
  url: string;
  elicitationId: string;
  origin: string;
  host: string;
  isLocalAddress: boolean;
  expiresAt?: number;
}

export interface ValidatedMcpUrl {
  url: string;
  origin: string;
  host: string;
  isLocalAddress: boolean;
}

export function validateMcpElicitationUrl(
  rawUrl: string,
): { ok: true; value: ValidatedMcpUrl } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      error: `Unsupported URL scheme: ${parsed.protocol.replace(/:$/, "")}`,
    };
  }

  return {
    ok: true,
    value: {
      url: parsed.toString(),
      origin: parsed.origin,
      host: parsed.hostname,
      isLocalAddress: isLocalOrPrivateHost(parsed.hostname),
    },
  };
}

function isLocalOrPrivateHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return true;
  }

  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;

  const octets = ipv4.slice(1).map((part) => Number(part));
  if (
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  const [a, b] = octets;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}
