export type BrowserGatewayProtocolErrorCode =
  | "invalid_type"
  | "invalid_value"
  | "unknown_field"
  | "unsupported_version"
  | "unsupported_kind"
  | "resource_limit"
  | "sequence_mismatch"
  | "identity_mismatch";

export class BrowserGatewayProtocolError extends Error {
  constructor(
    readonly code: BrowserGatewayProtocolErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "BrowserGatewayProtocolError";
  }
}
