import { describe, expect, it, vi } from "vitest";
import type { NetworkApprovalReviewInput } from "./networkApprovalReview.js";
import {
  createTypeSafeNetworkFirstPass,
  type TypeSafeNetworkFirstPassOptions,
} from "./typeSafeNetworkFirstPass.js";

function response(values: Record<string, number> = {}): Response {
  const standard = {
    authorized: 0.98,
    objective_match: 0.99,
    safe: 0.99,
    bounded_impact: 0.98,
  };
  return new Response(
    JSON.stringify({
      answers: Object.fromEntries(
        Object.entries({ ...standard, ...values }).map(([key, noul]) => [
          key,
          { type: "noul", noul },
        ]),
      ),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const input: NetworkApprovalReviewInput = {
  request: {
    requestId: "network-request-secret-id",
    sessionId: "session-secret-id",
    auditId: "audit-secret-id",
    terminalId: "terminal-secret-id",
    commandId: "command-secret-id",
    generation: 1,
    command: "npm view example version",
    cwd: "/workspace/project",
    reason: "Checking the package version requested by the user",
    host: "registry.npmjs.org",
    protocol: "https",
    port: 443,
    address: "104.16.24.34",
    family: 4,
    dnsAnswers: [
      { address: "104.16.24.34", family: 4 },
      { address: "104.16.25.34", family: 4 },
    ],
    destinationClass: "public",
  },
  userObjective: "Check the version of the example package",
  context: [
    {
      role: "user",
      content: "Check the version of the example package",
      directUserInstruction: true,
    },
    { role: "assistant", content: "I will query the package registry" },
  ],
};

function options(
  overrides: Partial<TypeSafeNetworkFirstPassOptions> = {},
): TypeSafeNetworkFirstPassOptions {
  return {
    getConfig: () => ({ enabled: true, threshold: 0.9 }),
    getApiKey: async () => "test-api-key",
    fetch: vi.fn(async () => response()),
    ...overrides,
  };
}

describe("TypeSafe network first-pass reviewer", () => {
  it("sends bounded command and destination evidence and allows only a confident low-risk match", async () => {
    const fetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => response(),
    );
    const reviewer = createTypeSafeNetworkFirstPass(
      options({
        getConfig: () => ({
          enabled: true,
          model: "jev-1.14.0",
          threshold: 0.92,
        }),
        fetch,
      }),
    );

    expect(await reviewer(input)).toMatchObject({
      outcome: "allow",
      risk: "low",
      userAuthorization: "high",
      status: "reviewed",
      model: "typesafe/jev-1.14.0",
    });
    expect(fetch).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(payload.model).toBe("jev-1.14.0");
    expect(payload.state.action).toMatchObject({
      command: input.request.command,
      cwd: input.request.cwd,
      reason: input.request.reason,
      userObjective: input.userObjective,
      context: input.context,
      humanEvidence: ["Check the version of the example package"],
      destination: {
        host: "registry.npmjs.org",
        protocol: "https",
        port: 443,
        retainedAddress: "104.16.24.34",
        family: 4,
        dnsAnswers: input.request.dnsAnswers,
        destinationClass: "public",
      },
    });
    const serialized = JSON.stringify(payload);
    for (const sensitiveId of [
      "network-request-secret-id",
      "session-secret-id",
      "audit-secret-id",
      "terminal-secret-id",
      "command-secret-id",
    ]) {
      expect(serialized).not.toContain(sensitiveId);
    }
    expect(payload.state.action.policy).toBeUndefined();
    expect(
      Object.values(payload.questions).every(
        (question: any) =>
          question.type === "noul" &&
          typeof question.instructions.policy === "string" &&
          typeof question.instructions.question === "string",
      ),
    ).toBe(true);
    expect(JSON.stringify(payload.questions)).toContain(
      "HTTPS/TCP request paths",
    );
    expect(JSON.stringify(payload.questions)).toContain(
      "routine bounded downloads",
    );
  });

  it("never calls Jev for non-public destinations", async () => {
    const fetch = vi.fn(async () => response());
    const reviewer = createTypeSafeNetworkFirstPass(options({ fetch }));
    expect(
      await reviewer({
        ...input,
        request: {
          ...input.request,
          destinationClass: "private",
        } as unknown as NetworkApprovalReviewInput["request"],
      }),
    ).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("defers when human authorization is missing or omitted", async () => {
    const fetch = vi.fn(async () => response());
    const reviewer = createTypeSafeNetworkFirstPass(options({ fetch }));
    expect(
      await reviewer({
        ...input,
        context: [{ role: "assistant", content: "The user requested this" }],
      }),
    ).toBeUndefined();
    expect(
      await reviewer({
        ...input,
        context: [
          ...input.context!,
          {
            role: "user",
            humanDecisionEvidence: true,
            content: JSON.stringify({
              evidenceOmitted: "Earlier restrictions omitted",
            }),
          },
        ],
      }),
    ).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("defers on uncertain risk, malformed answers, or secret-bearing evidence", async () => {
    const lowAnswers: Record<string, number>[] = [
      { authorized: 0.89 },
      { objective_match: 0.89 },
      { safe: 0.89 },
      { bounded_impact: 0.89 },
    ];
    for (const values of lowAnswers) {
      const fetch = vi.fn(async () => response(values));
      expect(
        await createTypeSafeNetworkFirstPass(options({ fetch }))(input),
      ).toBeUndefined();
    }

    const fetch = vi.fn(async () => response());
    const reviewer = createTypeSafeNetworkFirstPass(options({ fetch }));
    expect(
      await reviewer({
        ...input,
        request: {
          ...input.request,
          command: "curl https://host.test?token=raw-secret",
        },
      }),
    ).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("defers when key lookup times out and aborts an in-flight request", async () => {
    const timeout = createTypeSafeNetworkFirstPass(
      options({
        getConfig: () => ({ enabled: true, timeoutMs: 10 }),
        getApiKey: () => new Promise(() => undefined),
      }),
    );
    await expect(timeout(input)).resolves.toBeUndefined();

    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    });
    const reviewer = createTypeSafeNetworkFirstPass(options({ fetch }));
    const controller = new AbortController();
    const pending = reviewer({ ...input, signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
    expect(requestSignal?.aborted).toBe(true);
  });
});
