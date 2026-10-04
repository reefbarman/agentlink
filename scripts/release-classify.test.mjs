import {
  CLASSIFIER_PROMPT_VERSION,
  MAX_COMMIT_DIFF_CHARS,
  batchCommits,
  boundCommit,
  classifyCommits,
  validateClassification,
} from "./release-classify.mjs";

import assert from "node:assert/strict";
import test from "node:test";

const commit = (sha, units = ["vscode"], diff = "+x") => ({
  sha,
  subject: `fix: ${sha}`,
  body: "",
  files: ["src/a.ts"],
  units,
  diff,
});

const okResponse = (commits, model = "anthropic/claude-sonnet-5.5") => ({
  ok: true,
  status: 200,
  json: async () => ({
    model,
    choices: [{ message: { content: JSON.stringify({ commits }) } }],
  }),
});

test("marks oversized diffs as partial coverage instead of hiding truncation", () => {
  const bounded = boundCommit(
    commit("a", ["vscode"], "x".repeat(MAX_COMMIT_DIFF_CHARS + 10)),
  );
  assert.equal(bounded.coverage, "partial");
  assert.match(bounded.diff, /diff truncated: 10 more characters/u);
  assert.equal(boundCommit(commit("b")).coverage, "full");
});

test("omits commits beyond the run budget rather than silently classifying them", () => {
  const big = "x".repeat(MAX_COMMIT_DIFF_CHARS);
  const commits = Array.from({ length: 20 }, (_, index) =>
    commit(String(index), ["vscode"], big),
  );
  const { batches, omitted } = batchCommits(commits);
  assert.ok(batches.length >= 2);
  assert.ok(omitted.length > 0);
  const sent = batches.flat().map((entry) => entry.sha);
  assert.equal(sent.length + omitted.length, commits.length);
});

test("rejects unknown, duplicate, missing, and out-of-scope decisions", () => {
  const batch = [boundCommit(commit("a", ["sdk"])), boundCommit(commit("b"))];
  const valid = [
    { sha: "a", bump: "minor", breakingUnits: ["sdk"], summary: "Adds X." },
    { sha: "b", bump: "patch", breakingUnits: [], summary: "Fixes Y." },
  ];
  assert.equal(
    validateClassification({ commits: valid }, batch).a.bump,
    "minor",
  );
  assert.throws(
    () =>
      validateClassification(
        { commits: [...valid, { ...valid[0], sha: "z" }] },
        batch,
      ),
    /unknown commit z/u,
  );
  assert.throws(
    () => validateClassification({ commits: [valid[0], valid[0]] }, batch),
    /Duplicate/u,
  );
  assert.throws(
    () => validateClassification({ commits: [valid[0]] }, batch),
    /omitted b/u,
  );
  assert.throws(
    () =>
      validateClassification(
        { commits: [valid[0], { ...valid[1], breakingUnits: ["sdk"] }] },
        batch,
      ),
    /Invalid breaking units for b/u,
  );
  assert.throws(
    () =>
      validateClassification(
        { commits: [valid[0], { ...valid[1], bump: "major" }] },
        batch,
      ),
    /Invalid bump/u,
  );
});

test("sends a strict schema with privacy routing and records the model used", async () => {
  let request;
  const { decisions, omitted } = await classifyCommits([commit("a")], {
    apiKey: "test-key",
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return okResponse(
        [
          {
            sha: "a",
            bump: "patch",
            breakingUnits: [],
            summary: " Fixes  a. ",
          },
        ],
        "openai/gpt-6.1-sol",
      );
    },
  });
  assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(request.init.headers.Authorization, "Bearer test-key");
  assert.deepEqual(request.body.models, [
    "anthropic/claude-sonnet-5.5",
    "openai/gpt-6.1-sol",
  ]);
  assert.equal(request.body.response_format.json_schema.strict, true);
  assert.deepEqual(request.body.provider, {
    require_parameters: true,
    data_collection: "deny",
  });
  // With require_parameters, any sampling parameter that reasoning-model
  // endpoints reject leaves no eligible provider and OpenRouter returns 404.
  for (const key of ["temperature", "top_p", "top_k", "seed"]) {
    assert.equal(key in request.body, false, key);
  }
  assert.ok(!request.body.messages[1].content.includes("coverage"));
  assert.deepEqual(omitted, []);
  assert.deepEqual(decisions.a, {
    bump: "patch",
    breakingUnits: [],
    summary: "Fixes a.",
    coverage: "full",
    model: "openai/gpt-6.1-sol",
    promptVersion: CLASSIFIER_PROMPT_VERSION,
  });
});

test("reuses cached decisions and only sends new commits", async () => {
  const sent = [];
  const cached = {
    bump: "minor",
    breakingUnits: [],
    summary: "Cached.",
    promptVersion: CLASSIFIER_PROMPT_VERSION,
  };
  const { decisions } = await classifyCommits([commit("a"), commit("b")], {
    apiKey: "k",
    cache: { a: cached },
    fetchImpl: async (_url, init) => {
      const content = JSON.parse(init.body).messages[1].content;
      sent.push(content);
      return okResponse([
        { sha: "b", bump: "none", breakingUnits: [], summary: "B." },
      ]);
    },
  });
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].includes('"sha":"a"'));
  assert.equal(decisions.a, cached);
  assert.equal(decisions.b.bump, "none");
});

test("retries transient failures and fails closed on invalid output", async () => {
  let calls = 0;
  const { decisions } = await classifyCommits([commit("a")], {
    apiKey: "k",
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 503 };
      return okResponse([
        { sha: "a", bump: "patch", breakingUnits: [], summary: "A." },
      ]);
    },
  });
  assert.equal(calls, 2);
  assert.equal(decisions.a.bump, "patch");

  await assert.rejects(
    classifyCommits([commit("a")], {
      apiKey: "k",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "not json" } }] }),
      }),
    }),
    /Release classification failed/u,
  );
  await assert.rejects(
    classifyCommits([commit("a")], {
      apiKey: "k",
      fetchImpl: async () => ({ ok: false, status: 401 }),
    }),
    /HTTP 401/u,
  );
  await assert.rejects(
    classifyCommits([commit("a")], {
      apiKey: "k",
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        text: async () =>
          JSON.stringify({
            error: { message: "No endpoints found that support temperature" },
          }),
      }),
    }),
    /HTTP 404: No endpoints found that support temperature/u,
  );
});
