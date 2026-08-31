import type {
  CoreJsonValue,
  CoreProviderReplayEnvelope,
} from "./providerReplay.js";
import { expect, expectTypeOf, it } from "vitest";

it("pins provider replay transport contracts", () => {
  expectTypeOf<CoreJsonValue>().toEqualTypeOf<
    | null
    | boolean
    | number
    | string
    | CoreJsonValue[]
    | { [key: string]: CoreJsonValue }
  >();
  expectTypeOf<CoreProviderReplayEnvelope>().toEqualTypeOf<{
    providerId: string;
    codecVersion: number;
    payload: CoreJsonValue;
    serializedBytes: number;
    degraded?: boolean;
    degradedReason?: "size_limit" | "unsupported_payload";
  }>();
});

it("keeps provider replay envelopes serializable across runtimes", () => {
  const value: CoreProviderReplayEnvelope = {
    providerId: "openai-compatible:example",
    codecVersion: 1,
    payload: {
      choices: [
        {
          index: 0,
          reasoning: "private provider state",
          enabled: true,
          score: 0.75,
          metadata: null,
        },
      ],
    },
    serializedBytes: 128,
    degraded: false,
  };

  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
});
