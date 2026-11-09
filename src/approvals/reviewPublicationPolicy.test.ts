import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createReviewPublicationHost,
  isReviewPublicationCommand,
  type ReviewPublicationPreparation,
  type ReviewPublicationRequest,
  type ReviewPublicationSessionSnapshot,
} from "./reviewPublicationPolicy.js";

const ROOT = "/workspace";
const COMMAND =
  "gh pr comment 12 --repo reefbarman/agentlink --body 'Review note'";

function snapshot(
  text = "Review PR 12 in reefbarman/agentlink and post the review comment.",
  overrides: Partial<ReviewPublicationSessionSnapshot> = {},
): ReviewPublicationSessionSnapshot {
  return {
    builtinReview: true,
    foreground: true,
    humanInputRevision: 4,
    humanDecisions: {
      incomplete: false,
      entries: [
        {
          kind: "instruction",
          sequence: 1,
          recordedAt: 1,
          inputId: "human-1",
          text,
        },
      ],
    },
    queuedHumanInputs: [],
    ...overrides,
  };
}

function request(
  command: string,
  overrides: Partial<ReviewPublicationRequest> = {},
): ReviewPublicationRequest {
  return {
    sessionId: "session-1",
    command,
    cwd: ROOT,
    workspaceRoots: [ROOT],
    humanInputRevision: 4,
    ...overrides,
  };
}

function harness(state = snapshot()) {
  const host = createReviewPublicationHost({ getSessionSnapshot: () => state });
  const observe = (command: string, output: unknown, result = {}) =>
    host.observe({
      ...request(command),
      result: {
        exit_code: 0,
        output_complete: true,
        output_finalized: true,
        output: JSON.stringify(output),
        ...result,
      },
    });
  observe("gh api repos/reefbarman/agentlink/pulls/12", {
    number: 12,
    html_url: "https://github.com/reefbarman/agentlink/pull/12",
  });
  return { host, observe, state };
}

describe("review publication policy", () => {
  it.each([
    "gh pr review 12 -R reefbarman/agentlink --approve --body note",
    "gh pr review 12 -R reefbarman/agentlink --request-changes --body note",
    "gh api repos/reefbarman/agentlink/pulls/12/comments -f body=note -f path=src/file.ts -F line=4 -f commit_id=abc",
    "gh api repos/reefbarman/agentlink/pulls/12/comments/22/replies -f body=note",
  ])("matches scoped supported publication: %s", (command) => {
    expect(harness().host.prepare(request(command))).toBeDefined();
  });

  it.each([
    "gh api repos/reefbarman/agentlink/issues/99/comments -f body=note",
    "gh api repos/other/repo/issues/12/comments -f body=note",
    "gh pr comment 12 -R reefbarman/agentlink --edit-last --body note",
    "gh api repos/reefbarman/agentlink/pulls/12/merge -X PUT",
    "gh api repos/reefbarman/agentlink/pulls/12/reviews -f event=DISMISS",
    "gh api repos/reefbarman/agentlink/issues/12/comments -f body=one -f body=two",
    "gh api repos/reefbarman/agentlink/issues/12/comments -f body=note -H 'Authorization: Bearer secret'",
    "gh pr comment 12 -R reefbarman/agentlink --body note; rm file",
  ])("does not extend the exception to unsupported effects: %s", (command) => {
    expect(harness().host.prepare(request(command))).toBeUndefined();
  });

  it.each([
    "Review PR 12 in reefbarman/agentlink-extra",
    "Review PR 12 in other-reefbarman/agentlink",
    "Review https://github.com/reefbarman/agentlink/pull/12 but don't leave any comments",
    "Review https://github.com/reefbarman/agentlink/pull/12 without posting",
    "Review https://github.com/reefbarman/agentlink/pull/12, no comments, just findings",
    "Review https://github.com/reefbarman/agentlink/pull/12, only summarise",
  ])(
    "does not confuse scope or restrictions in direct human input: %s",
    (text) => {
      expect(
        harness(snapshot(text)).host.prepare(request(COMMAND)),
      ).toBeUndefined();
    },
  );

  it.each([
    "skip publishing",
    "avoid posting",
    "not post",
    "only summarise instead of publishing",
  ])("does not invert Yes to a restrictive question: %s", (restriction) => {
    const state = snapshot();
    state.humanDecisions = {
      incomplete: false,
      entries: [
        {
          kind: "question",
          sequence: 1,
          recordedAt: 1,
          evidence: {
            source: "human_ui",
            binding: {
              schemaVersion: 1,
              sessionId: "session-1",
              questionRequestId: "q-request",
              toolCallId: "q-tool",
              context: "Review https://github.com/reefbarman/agentlink/pull/12",
              questions: [
                {
                  id: "review",
                  question: `Should I ${restriction}?`,
                  type: "yes_no",
                },
              ],
            },
            answers: { review: "Yes" },
            notes: {},
          },
        },
      ],
    };
    expect(harness(state).host.prepare(request(COMMAND))).toBeUndefined();
  });

  it("revalidates inherited GitHub host changes and rejects opaque terminal environments", () => {
    const { host } = harness();
    const context = host.prepare(request(COMMAND))!;
    expect(
      host.prepare(request(COMMAND, { environmentOpaque: true })),
    ).toBeUndefined();
    vi.stubEnv("GH_HOST", "ghe.example");
    try {
      expect(host.isCurrent("session-1", context)).toBe(false);
      expect(host.prepare(request(COMMAND))).toBeUndefined();
      expect(
        host.prepare(
          request(
            "gh api --hostname github.com repos/reefbarman/agentlink/issues/12/comments -f body=Note",
          ),
        ),
      ).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects background, queued, missing and incomplete scope even after PR observation", () => {
    for (const state of [
      snapshot(undefined, { foreground: false }),
      snapshot(undefined, { queuedHumanInputs: ["don't publish"] }),
      snapshot("Inspect this repository"),
      snapshot(undefined, {
        humanDecisions: { incomplete: true, entries: [] },
      }),
    ])
      expect(harness(state).host.prepare(request(COMMAND))).toBeUndefined();
  });

  it("requires untouched agent-owned pending reviews and complete empty comment pages", () => {
    const { host, observe } = harness();
    const review = {
      id: 77,
      user: { login: "same-account" },
      body: "Draft",
      state: "PENDING",
    };
    const submit =
      "gh api repos/reefbarman/agentlink/pulls/12/reviews/77/events -f event=APPROVE";
    const read = "gh api repos/reefbarman/agentlink/pulls/12/reviews/77";
    const comments = `${read}/comments --paginate --slurp`;
    observe(read, review);
    expect(host.prepare(request(submit))).toBeUndefined(); // Human-owned draft, no creation receipt.
    observe(
      "gh api repos/reefbarman/agentlink/pulls/12/reviews -f body=Draft",
      review,
    );
    observe(read, review);
    expect(host.prepare(request(submit))).toBeUndefined();
    observe(comments, [[]]);
    expect(host.prepare(request(submit))).toMatchObject({
      kind: "submit_review",
    });
    observe(comments, [[{ body: "Human inline comment" }]]);
    expect(host.prepare(request(submit))).toBeUndefined();
    observe(comments, [[]]);
    observe(read, { ...review, body: "Human changed this draft" });
    expect(host.prepare(request(submit))).toBeUndefined();
    observe(read, review);
    observe(comments, [[]], { output_complete: false });
    expect(host.prepare(request(submit))).toBeUndefined();
    observe(`${read}/comments`, []);
    expect(host.prepare(request(submit))).toBeUndefined();
  });

  it("does not mint ownership receipts from transformed, partial, cancelled or failed publications", () => {
    for (const result of [
      { output_complete: false },
      { output_finalized: false },
      { exit_code: null },
      { output_transformed: true },
      { termination_reason: "cancelled" },
    ]) {
      const { host, observe } = harness();
      const comment = { id: 23, body: "Note", user: { login: "same-account" } };
      observe(
        "gh api repos/reefbarman/agentlink/issues/12/comments -f body=Note",
        comment,
        result,
      );
      observe("gh api repos/reefbarman/agentlink/issues/comments/23", comment);
      expect(
        host.prepare(
          request(
            "gh api repos/reefbarman/agentlink/issues/comments/23 -X PATCH -f body=Edited",
          ),
        ),
      ).toBeUndefined();
    }
  });

  it("never treats arbitrary structured answers or a human note as an affirmative scope grant", () => {
    for (const [answer, note, permitted] of [
      ["Yes", "", true],
      ["No", "", false],
      ["Only inspect", "", false],
      ["Yes", "do not post", false],
    ] as const) {
      const state = snapshot();
      state.humanDecisions = {
        incomplete: false,
        entries: [
          {
            kind: "question",
            sequence: 1,
            recordedAt: 1,
            evidence: {
              source: "human_ui",
              binding: {
                schemaVersion: 1,
                sessionId: "session-1",
                questionRequestId: "q-request",
                toolCallId: "q-tool",
                context:
                  "Review https://github.com/reefbarman/agentlink/pull/12",
                questions: [
                  {
                    id: "review",
                    question: "Publish the review?",
                    type: "yes_no",
                  },
                ],
              },
              answers: { review: answer },
              notes: { review: note },
            },
          },
        ],
      };
      expect(Boolean(harness(state).host.prepare(request(COMMAND)))).toBe(
        permitted,
      );
    }
  });

  it("does not revive a report-only restriction with an ambiguous subsequent review instruction", () => {
    const state = snapshot(
      "Review PR 12 in reefbarman/agentlink, report only.",
    );
    state.humanDecisions = {
      incomplete: false,
      entries: [
        ...state.humanDecisions.entries,
        {
          kind: "instruction",
          sequence: 2,
          recordedAt: 2,
          inputId: "new-review",
          text: "Review https://github.com/reefbarman/agentlink/pull/12",
        },
      ],
    };
    expect(harness(state).host.prepare(request(COMMAND))).toBeUndefined();
  });
  it("accepts two distinct allowlisted headers but rejects duplicates and auth", () => {
    const { host } = harness();
    const valid =
      "gh api repos/reefbarman/agentlink/issues/12/comments -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' -f body=Note";
    expect(host.prepare(request(valid))).toBeDefined();
    expect(
      host.prepare(
        request(
          "gh api repos/reefbarman/agentlink/issues/12/comments -H 'Accept: one' -H 'accept: two' -f body=Note",
        ),
      ),
    ).toBeUndefined();
    expect(
      host.prepare(
        request(
          "gh api repos/reefbarman/agentlink/issues/12/comments -H 'Authorization: Bearer token' -f body=Note",
        ),
      ),
    ).toBeUndefined();
  });

  it("revalidates inherited PR identity across a clear continue instruction", () => {
    const state = snapshot();
    const host = createReviewPublicationHost({
      getSessionSnapshot: () => state,
    });
    host.observe({
      ...request("gh pr view 12 --repo reefbarman/agentlink --json url,number"),
      result: {
        exit_code: 0,
        output_complete: true,
        output_finalized: true,
        output: JSON.stringify({
          number: 12,
          url: "https://github.com/reefbarman/agentlink/pull/12",
        }),
      },
    });
    state.humanInputRevision = 5;
    state.humanDecisions = {
      ...state.humanDecisions,
      entries: [
        ...state.humanDecisions.entries,
        {
          kind: "instruction",
          sequence: 2,
          recordedAt: 2,
          inputId: "human-2",
          text: "Continue",
        },
      ],
    };
    expect(
      host.assess(request(COMMAND, { humanInputRevision: 5 })),
    ).toMatchObject({
      status: "verified",
      context: { sourceInputIds: ["human-1"] },
    });
  });

  it("assesses missing PR evidence with one opt-in exact read prerequisite", () => {
    const state = snapshot();
    const host = createReviewPublicationHost({
      getSessionSnapshot: () => state,
    });
    const input = request(COMMAND, { allowPrerequisite: true });
    const first = host.assess(input);
    expect(first).toEqual({
      status: "unavailable",
      reason: "pr_observation_missing",
      prerequisite: {
        command:
          "gh pr view https://github.com/reefbarman/agentlink/pull/12 --json number,url,headRefOid",
      },
    } satisfies ReviewPublicationPreparation);
    expect(host.assess(input)).toEqual({
      status: "unavailable",
      reason: "pr_observation_missing",
    });
    expect(host.prepare(input)).toBeUndefined();
    expect(
      host.isCurrent("session-1", {
        version: 1,
        mode: "builtin_review",
        command: COMMAND,
        cwd: ROOT,
        humanInputRevision: 4,
        target: {
          host: "github.com",
          repository: "reefbarman/agentlink",
          pr: 12,
        },
        kind: "comment",
        sourceInputIds: ["human-1"],
        verified: true,
        payloadFiles: [],
        workspaceRoots: [ROOT],
      }),
    ).toBe(false);
    host.observe({
      ...request(
        first.status === "unavailable" ? first.prerequisite!.command : "",
      ),
      result: {
        exit_code: 0,
        output_complete: true,
        output_finalized: true,
        output: JSON.stringify({
          number: 12,
          url: "https://github.com/reefbarman/agentlink/pull/12",
          headRefOid: "abc",
        }),
      },
    });
    expect(host.assess(input)).toMatchObject({ status: "verified" });
  });

  it.each([
    "also review https://github.com/reefbarman/agentlink/pull/13",
    "please also review PR #13",
    "PR#12 and PR#13 are ready for review\nCheck the relevant tests too.",
    "Review https://github.com/reefbarman/agentlink/pull/12 and https://github.com/reefbarman/agentlink/pull/13",
  ])("keeps exact targets across a clear additive request: %s", (text) => {
    const { host, state, observe } = harness();
    state.humanDecisions = {
      ...state.humanDecisions,
      entries: [
        ...state.humanDecisions.entries,
        {
          kind: "instruction",
          sequence: 2,
          recordedAt: 2,
          inputId: "human-2",
          text,
        },
      ],
    };
    observe("gh api repos/reefbarman/agentlink/pulls/13", {
      number: 13,
      html_url: "https://github.com/reefbarman/agentlink/pull/13",
    });
    expect(host.prepare(request(COMMAND))).toBeDefined();
    expect(
      host.prepare(
        request("gh pr review 13 -R reefbarman/agentlink --approve"),
      ),
    ).toBeDefined();
    expect(
      host.prepare(
        request("gh pr review 14 -R reefbarman/agentlink --approve"),
      ),
    ).toBeUndefined();
  });

  it.each([
    "Review https://github.com/reefbarman/agentlink/pull/12. It supersedes #10 and is similar to PR 9.",
    "Review https://github.com/reefbarman/agentlink/pull/12; compare https://github.com/reefbarman/agentlink/pull/10 and PR 9 for context.",
  ])("never treats contextual PR references as review targets: %s", (text) => {
    const { host, observe } = harness(snapshot(text));
    expect(host.prepare(request(COMMAND))).toBeDefined();
    for (const pr of [9, 10]) {
      observe(`gh api repos/reefbarman/agentlink/pulls/${pr}`, {
        number: pr,
        html_url: `https://github.com/reefbarman/agentlink/pull/${pr}`,
      });
      expect(
        host.assess(
          request(`gh pr review ${pr} -R reefbarman/agentlink --approve`, {
            allowPrerequisite: true,
          }),
        ),
      ).toEqual({ status: "unavailable", reason: "scope_unavailable" });
    }
  });

  it("limits a ready-for-review follow-up to its leading target list", () => {
    const { host, state, observe } = harness();
    state.humanDecisions = {
      ...state.humanDecisions,
      entries: [
        ...state.humanDecisions.entries,
        {
          kind: "instruction",
          sequence: 2,
          recordedAt: 2,
          inputId: "ready-review",
          text: "PR 12 is ready for review. Depends on #8.",
        },
      ],
    };
    observe("gh api repos/reefbarman/agentlink/pulls/8", {
      number: 8,
      html_url: "https://github.com/reefbarman/agentlink/pull/8",
    });
    expect(host.prepare(request(COMMAND))).toBeDefined();
    expect(
      host.assess(
        request("gh pr review 8 -R reefbarman/agentlink --approve", {
          allowPrerequisite: true,
        }),
      ),
    ).toEqual({ status: "unavailable", reason: "scope_unavailable" });
  });

  it("replaces scope on a fresh review request rather than carrying unrelated targets", () => {
    const { host, state, observe } = harness();
    state.humanDecisions = {
      ...state.humanDecisions,
      entries: [
        ...state.humanDecisions.entries,
        {
          kind: "instruction",
          sequence: 2,
          recordedAt: 2,
          inputId: "human-2",
          text: "Review https://github.com/reefbarman/agentlink/pull/13",
        },
      ],
    };
    observe("gh api repos/reefbarman/agentlink/pulls/13", {
      number: 13,
      html_url: "https://github.com/reefbarman/agentlink/pull/13",
    });
    expect(host.assess(request(COMMAND, { allowPrerequisite: true }))).toEqual({
      status: "unavailable",
      reason: "scope_unavailable",
    });
    expect(
      host.prepare(
        request("gh pr review 13 -R reefbarman/agentlink --approve"),
      ),
    ).toBeDefined();
  });

  it.each([
    "Clear scope",
    "Reset",
    "Stop the review",
    "Ignore them",
    "Pause the review",
    "Continue with something else",
    "Please do something with the review",
    "Review PR 12 in other/repo and third/repo",
  ])(
    "does not confuse ambiguous or stopping input with continuation: %s",
    (text) => {
      const { host, state } = harness();
      state.humanDecisions = {
        ...state.humanDecisions,
        entries: [
          ...state.humanDecisions.entries,
          {
            kind: "instruction",
            sequence: 2,
            recordedAt: 2,
            inputId: "human-2",
            text,
          },
        ],
      };
      expect(
        host.assess(request(COMMAND, { allowPrerequisite: true })),
      ).toEqual({ status: "unavailable", reason: "scope_unavailable" });
      state.humanDecisions = {
        ...state.humanDecisions,
        entries: [
          ...state.humanDecisions.entries,
          {
            kind: "instruction",
            sequence: 3,
            recordedAt: 3,
            inputId: "human-3",
            text: "also review PR #13",
          },
        ],
      };
      expect(
        host.assess(
          request("gh pr review 13 -R reefbarman/agentlink --approve", {
            allowPrerequisite: true,
          }),
        ),
      ).toEqual({ status: "unavailable", reason: "scope_unavailable" });
    },
  );

  it("inherits the exact host and repository, never resolving an enterprise task onto github.com", () => {
    const state = snapshot(
      "Review https://ghe.example/reefbarman/agentlink/pull/12",
    );
    state.humanDecisions = {
      ...state.humanDecisions,
      entries: [
        ...state.humanDecisions.entries,
        {
          kind: "instruction",
          sequence: 2,
          recordedAt: 2,
          inputId: "human-2",
          text: "also review PR #13",
        },
      ],
    };
    const host = createReviewPublicationHost({
      getSessionSnapshot: () => state,
    });
    expect(
      host.assess(
        request(
          "gh api repos/reefbarman/agentlink/pulls/13/reviews -f event=APPROVE",
          { allowPrerequisite: true },
        ),
      ),
    ).toEqual({ status: "unavailable", reason: "scope_unavailable" });
    expect(
      host.assess(
        request(
          "gh api --hostname ghe.example repos/reefbarman/agentlink/pulls/13/reviews -f event=APPROVE",
          { allowPrerequisite: true },
        ),
      ),
    ).toMatchObject({
      status: "unavailable",
      reason: "pr_observation_missing",
      prerequisite: {
        command:
          "gh pr view https://ghe.example/reefbarman/agentlink/pull/13 --json number,url,headRefOid",
      },
    });
  });

  it("does not infer a repository for bare PR numbers when multiple origins are in scope", () => {
    const state = snapshot(
      "Review https://github.com/reefbarman/agentlink/pull/12 and https://github.com/other/repo/pull/13",
    );
    state.humanDecisions = {
      ...state.humanDecisions,
      entries: [
        ...state.humanDecisions.entries,
        {
          kind: "instruction",
          sequence: 2,
          recordedAt: 2,
          inputId: "human-2",
          text: "also review PR #14",
        },
      ],
    };
    const host = createReviewPublicationHost({
      getSessionSnapshot: () => state,
    });
    expect(
      host.assess(
        request("gh pr review 14 -R reefbarman/agentlink --approve", {
          allowPrerequisite: true,
        }),
      ),
    ).toEqual({ status: "unavailable", reason: "scope_unavailable" });
  });

  it.each([
    "git fetch origin",
    "gh api user --jq .login",
    "gh api repos/reefbarman/agentlink/pulls/12",
    "gh pr view 12 --repo reefbarman/agentlink --json headRefOid",
  ])(
    "does not emit publication diagnostics for unrelated work or reads: %s",
    (command) => {
      expect(harness().host.assess(request(command))).toEqual({
        status: "not_applicable",
      });
    },
  );

  it("keeps unsupported combined publications on ordinary handling without a prerequisite", () => {
    expect(
      harness().host.assess(
        request(`${COMMAND}; rm file`, { allowPrerequisite: true }),
      ),
    ).toEqual({ status: "unavailable", reason: "unsupported_command" });
  });

  it("does not offer a fresh prerequisite when publication body or flags change for the same PR", () => {
    const host = createReviewPublicationHost({
      getSessionSnapshot: () => snapshot(),
    });
    expect(
      host.assess(request(COMMAND, { allowPrerequisite: true })),
    ).toHaveProperty("prerequisite");
    expect(
      host.assess(
        request(
          "gh pr review 12 -R reefbarman/agentlink --approve --body changed",
          { allowPrerequisite: true },
        ),
      ),
    ).toEqual({ status: "unavailable", reason: "pr_observation_missing" });
  });

  it.each([
    "gh api repos/reefbarman/agentlink/pulls/12/reviews/77/events -f event=APPROVE",
    "gh api repos/reefbarman/agentlink/issues/comments/23 -X PATCH -f body=Edit",
  ])("never substitutes a PR read for missing ownership: %s", (command) => {
    expect(
      harness().host.assess(request(command, { allowPrerequisite: true })),
    ).toEqual({ status: "unavailable", reason: "ownership_unverified" });
  });

  it("distinguishes unreadable payloads from invalid payload content before requesting evidence", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "publication-payload-"));
    try {
      const file = path.join(dir, "review.json");
      const host = createReviewPublicationHost({
        getSessionSnapshot: () => snapshot(),
      });
      const command = `gh api repos/reefbarman/agentlink/pulls/12/reviews --input ${file}`;
      expect(
        host.assess(request(command, { allowPrerequisite: true })),
      ).toEqual({ status: "unavailable", reason: "payload_unavailable" });
      for (const content of [
        "not JSON",
        "[]",
        '{"unrecognised":"value"}',
        '{"event":"DISMISS"}',
      ]) {
        writeFileSync(file, content);
        expect(
          host.assess(request(command, { allowPrerequisite: true })),
        ).toEqual({ status: "unavailable", reason: "unsupported_payload" });
      }
      writeFileSync(file, '{"event":"COMMENT","body":"Review note"}');
      expect(
        host.assess(request(command, { allowPrerequisite: true })),
      ).toHaveProperty("prerequisite");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects CRLF even when it appears in whitespace directly after an allowlisted header name", () => {
    expect(
      harness().host.prepare(
        request(
          "gh api repos/reefbarman/agentlink/issues/12/comments -f body=Note -H 'Accept:\r\nAuthorization: Bearer token'",
        ),
      ),
    ).toBeUndefined();
  });

  it("tags only parsed publication commands as telemetry candidates", () => {
    expect(isReviewPublicationCommand(COMMAND)).toBe(true);
    expect(
      isReviewPublicationCommand(
        "gh pr view 12 --repo reefbarman/agentlink --json url,number",
      ),
    ).toBe(false);
    expect(
      isReviewPublicationCommand(
        `gh pr comment 12 --repo reefbarman/agentlink --body "$TOKEN"`,
      ),
    ).toBe(false);
  });

  it("permits only the built-in foreground review with an explicitly scoped target", () => {
    const state = snapshot();
    const host = createReviewPublicationHost({
      getSessionSnapshot: () => state,
    });
    const getPr = request(
      "gh pr view 12 --repo reefbarman/agentlink --json url,number",
    );
    host.observe({
      ...getPr,
      result: {
        exit_code: 0,
        output: JSON.stringify({
          url: "https://github.com/reefbarman/agentlink/pull/12",
          number: 12,
        }),
        output_complete: true,
        output_finalized: true,
      },
    });

    expect(host.prepare(request(COMMAND))).toMatchObject({
      target: {
        host: "github.com",
        repository: "reefbarman/agentlink",
        pr: 12,
      },
      kind: "comment",
      sourceInputIds: ["human-1"],
    });
    expect(
      host.prepare(
        request(COMMAND, {
          command: "gh pr comment 12 --repo other/repo --body 'Review note'",
        }),
      ),
    ).toBeUndefined();
    expect(
      host.prepare(
        request(COMMAND, {
          command:
            "gh api --hostname ghe.example repos/reefbarman/agentlink/issues/12/comments --method POST --field body=note",
        }),
      ),
    ).toBeUndefined();
    expect(
      createReviewPublicationHost({
        getSessionSnapshot: () => ({ ...state, builtinReview: false }),
      }).prepare(request(COMMAND)),
    ).toBeUndefined();
    expect(
      host.prepare(request(COMMAND, { hasEnvOverrides: true })),
    ).toBeUndefined();
    expect(
      host.prepare(request(COMMAND, { humanInputRevision: 3 })),
    ).toBeUndefined();
    expect(
      host.prepare(
        request(COMMAND, {
          command:
            "gh pr comment 12 --repo reefbarman/agentlink --body 'Review note'",
          cwd: "/outside",
        }),
      ),
    ).toBeUndefined();
  });

  it("falls back for report-only requests and later unrelated human input", () => {
    const state = snapshot(
      "Review PR 12 in reefbarman/agentlink, report only, do not post.",
    );
    const host = createReviewPublicationHost({
      getSessionSnapshot: () => state,
    });
    host.observe({
      ...request("gh pr view 12 --repo reefbarman/agentlink --json url,number"),
      result: {
        exit_code: 0,
        output: JSON.stringify({
          url: "https://github.com/reefbarman/agentlink/pull/12",
          number: 12,
        }),
        output_complete: true,
        output_finalized: true,
      },
    });
    expect(host.prepare(request(COMMAND))).toBeUndefined();

    state.humanInputRevision = 5;
    state.humanDecisions = {
      incomplete: false,
      entries: [
        ...state.humanDecisions.entries,
        {
          kind: "instruction",
          sequence: 2,
          recordedAt: 2,
          inputId: "human-2",
          text: "Now inspect issue 90 in another/repository.",
        },
      ],
    };
    expect(
      host.prepare(request(COMMAND, { humanInputRevision: 5 })),
    ).toBeUndefined();
  });

  it("requires a same-task receipt and exact fresh GET before editing an owned comment", () => {
    const state = snapshot();
    const host = createReviewPublicationHost({
      getSessionSnapshot: () => state,
    });
    const observe = (command: string, output: unknown) => {
      host.observe({
        ...request(command),
        result: {
          exit_code: 0,
          output: JSON.stringify(output),
          output_complete: true,
          output_finalized: true,
        },
      });
    };
    observe("gh pr view 12 --repo reefbarman/agentlink --json url,number", {
      url: "https://github.com/reefbarman/agentlink/pull/12",
      number: 12,
    });
    const create =
      "gh api repos/reefbarman/agentlink/issues/12/comments --method POST --field body=Note";
    observe(create, { id: 101, user: { login: "same-account" }, body: "Note" });
    const edit =
      "gh api repos/reefbarman/agentlink/issues/comments/101 --method PATCH --field body=Edited";
    expect(host.prepare(request(edit))).toBeUndefined();

    observe("gh api repos/reefbarman/agentlink/issues/comments/101", {
      id: 101,
      user: { login: "same-account" },
      body: "Note",
    });
    expect(host.prepare(request(edit))).toMatchObject({ kind: "edit_comment" });
    expect(
      host.prepare(
        request(
          "gh api --hostname ghe.example repos/reefbarman/agentlink/issues/comments/101 --method PATCH --field body=Edited",
        ),
      ),
    ).toBeUndefined();
    expect(
      host.prepare(
        request(
          "gh api repos/reefbarman/agentlink/pulls/12/reviews/101/events --method POST --field event=APPROVE",
        ),
      ),
    ).toBeUndefined();
  });

  it("binds body-file previews to the original reference, roots, and current hash", () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "review-publication-"),
    );
    try {
      const bodyPath = path.join(directory, "body.json");
      writeFileSync(bodyPath, JSON.stringify({ body: "Original" }));
      const state = snapshot();
      const host = createReviewPublicationHost({
        getSessionSnapshot: () => state,
      });
      host.observe({
        ...request(
          "gh pr view 12 --repo reefbarman/agentlink --json url,number",
        ),
        result: {
          exit_code: 0,
          output: JSON.stringify({
            url: "https://github.com/reefbarman/agentlink/pull/12",
            number: 12,
          }),
          output_complete: true,
          output_finalized: true,
        },
      });
      const bodyCommand = `gh api repos/reefbarman/agentlink/issues/12/comments --method POST --input ${bodyPath}`;
      expect(
        host.prepare(request(`${bodyCommand} -f body=QueryField`)),
      ).toBeUndefined();
      const context = host.prepare(request(bodyCommand));
      expect(context?.payloadPreviews).toEqual([
        { reference: bodyPath, content: '{"body":"Original"}' },
      ]);
      expect(context && host.isCurrent("session-1", context)).toBe(true);
      writeFileSync(bodyPath, JSON.stringify({ body: "Changed" }));
      expect(context && host.isCurrent("session-1", context)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  describe("real review-session shapes", () => {
    const observeIn = (
      host: ReturnType<typeof createReviewPublicationHost>,
      command: string,
      output: unknown,
    ) =>
      host.observe({
        ...request(command),
        result: {
          exit_code: 0,
          output: JSON.stringify(output),
          output_complete: true,
          output_finalized: true,
        },
      });
    const reviewPrompt =
      "Review GitHub pull request https://github.com/reefbarman/agentlink/pull/12. Compare the pull request against its base branch, inspect the changed code and relevant surrounding behavior, run targeted validation when useful, and report actionable findings with file and line references. Do not modify the pull request branch unless the user explicitly asks for fixes.";

    it("authorises the PR named by the Review worktree prompt despite trailing punctuation", () => {
      const host = harness(snapshot(reviewPrompt)).host;
      expect(host.prepare(request(COMMAND))).toMatchObject({
        target: { repository: "reefbarman/agentlink", pr: 12 },
      });
    });

    it("accepts a gh pr view read that omits url and number", () => {
      const state = snapshot(reviewPrompt);
      const host = createReviewPublicationHost({
        getSessionSnapshot: () => state,
      });
      expect(host.prepare(request(COMMAND))).toBeUndefined();
      observeIn(
        host,
        "gh pr view 12 --repo reefbarman/agentlink --json headRefOid,state,reviewDecision",
        { headRefOid: "abc", state: "OPEN", reviewDecision: "" },
      );
      expect(host.prepare(request(COMMAND))).toMatchObject({
        target: { repository: "reefbarman/agentlink", pr: 12 },
      });
    });

    it.each([
      [{ number: 13, headRefOid: "abc" }],
      [{ url: "https://github.com/reefbarman/agentlink/pull/13" }],
      [{ url: "https://github.com/other/repo/pull/12", number: 12 }],
      [{}],
    ])("rejects a gh pr view read with mismatched identity: %j", (output) => {
      const host = createReviewPublicationHost({
        getSessionSnapshot: () => snapshot(reviewPrompt),
      });
      observeIn(
        host,
        "gh pr view 12 --repo reefbarman/agentlink --json url,number,headRefOid",
        output,
      );
      expect(host.prepare(request(COMMAND))).toBeUndefined();
    });

    it.skipIf(process.platform === "win32")(
      "accepts a review payload staged under /tmp",
      () => {
        const directory = mkdtempSync("/tmp/review-publication-");
        try {
          const payloadPath = path.join(directory, "review.json");
          writeFileSync(
            payloadPath,
            JSON.stringify({
              commit_id: "abc",
              event: "COMMENT",
              body: "Summary",
              comments: [
                { path: "src/a.ts", line: 3, side: "RIGHT", body: "x" },
              ],
            }),
          );
          const state = snapshot(reviewPrompt);
          const host = createReviewPublicationHost({
            getSessionSnapshot: () => state,
          });
          observeIn(
            host,
            "gh pr view 12 --repo reefbarman/agentlink --json headRefOid",
            { headRefOid: "abc" },
          );
          const context = host.prepare(
            request(
              `gh api --method POST repos/reefbarman/agentlink/pulls/12/reviews --input ${payloadPath} --jq '{id,state,html_url}'`,
            ),
          );
          expect(context).toMatchObject({ kind: "review" });
          expect(context?.payloadFiles[0]?.reference).toBe(payloadPath);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    );
  });

  it("records only completed, untransformed successful reads at their request revision", () => {
    const state = snapshot();
    const host = createReviewPublicationHost({
      getSessionSnapshot: () => state,
    });
    const read = request(
      "gh pr view 12 --repo reefbarman/agentlink --json url,number",
    );
    const result = {
      exit_code: 0,
      output: JSON.stringify({
        url: "https://github.com/reefbarman/agentlink/pull/12",
        number: 12,
      }),
      output_complete: true,
      output_finalized: true,
    };
    host.observe({ ...read, humanInputRevision: 3, result });
    expect(host.prepare(request(COMMAND))).toBeUndefined();
    host.observe({ ...read, result: { ...result, output_transformed: true } });
    expect(host.prepare(request(COMMAND))).toBeUndefined();
    host.observe({ ...read, result: { ...result, exit_code: null } });
    expect(host.prepare(request(COMMAND))).toBeUndefined();
    host.observe({ ...read, result: { ...result, output_complete: false } });
    expect(host.prepare(request(COMMAND))).toBeUndefined();
  });
});
