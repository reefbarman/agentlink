export type CoreJsonValue =
  | null
  | boolean
  | number
  | string
  | CoreJsonValue[]
  | { [key: string]: CoreJsonValue };

export interface CoreProviderReplayEnvelope {
  providerId: string;
  codecVersion: number;
  payload: CoreJsonValue;
  serializedBytes: number;
  degraded?: boolean;
  degradedReason?: "size_limit" | "unsupported_payload";
}
