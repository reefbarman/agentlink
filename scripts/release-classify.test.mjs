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

test("rejects duplicate, missing, and out-of-scope decisions", () => {
  const batch = [boundCommit(commit("a", ["sdk"])), boundCommit(commit("b"))];
  const valid = [
    { sha: "a", bump: "minor", breakingUnits: ["sdk"], summary: "Adds X." },
    { sha: "b", bump: "patch", breakingUnits: [], summary: "Fixes Y." },
  ];
  assert.equal(
    validateClassification({ commits: valid }, batch).a.bump,
    "minor",
  );
  // Extra commits the model was not asked about are ignored.
  assert.deepEqual(
    Object.keys(
      validateClassification(
        { commits: [...valid, { ...valid[0], sha: "z" }] },
        batch,
      ),
    ).sort(),
    ["a", "b"],
  );
  // An unknown commit cannot stand in for a requested one.
  assert.throws(
    () =>
      validateClassification(
        { commits: [valid[0], { ...valid[1], sha: "z" }] },
        batch,
      ),
    /omitted b/u,
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

test("retries only omitted commits and preserves validated decisions and model attribution", async () => {
  const requests = [];
  const first = {
    sha: "a",
    bump: "minor",
    breakingUnits: ["sdk"],
    summary: "Adds A.",
  };
  const second = {
    sha: "b",
    bump: "patch",
    breakingUnits: [],
    summary: "Fixes B.",
  };
  const { decisions, omitted } = await classifyCommits(
    [commit("a", ["sdk"]), commit("b")],
    {
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return requests.length === 1
          ? okResponse([first], "first-model")
          : okResponse([{ ...first, bump: "none" }, second], "retry-model");
      },
    },
  );
  assert.equal(requests.length, 2);
  const requestedShas = (request) =>
    JSON.parse(
      request.messages[1].content.slice(
        "Untrusted commit data (JSON):\n".length,
      ),
    ).map((entry) => entry.sha);
  assert.deepEqual(requestedShas(requests[0]), ["a", "b"]);
  assert.deepEqual(requestedShas(requests[1]), ["b"]);
  // Keep the existing provider-compatible schema, with exact coverage checked
  // locally instead of adding unsupported array constraints to strict output.
  for (const request of requests) {
    const schema =
      request.response_format.json_schema.schema.properties.commits;
    assert.equal("minItems" in schema, false);
    assert.equal("maxItems" in schema, false);
  }
  assert.equal(decisions.a.bump, "minor");
  assert.deepEqual(decisions.a.breakingUnits, ["sdk"]);
  assert.equal(decisions.a.model, "first-model");
  assert.equal(decisions.b.model, "retry-model");
  assert.deepEqual(omitted, []);
});

test("persistent omissions fail closed after bounded retries", async () => {
  let calls = 0;
  await assert.rejects(
    classifyCommits([commit("a"), commit("b")], {
      apiKey: "k",
      fetchImpl: async () => {
        calls++;
        return okResponse([
          { sha: "a", bump: "patch", breakingUnits: [], summary: "A." },
        ]);
      },
    }),
    /Release classification failed: Classifier omitted b/u,
  );
  assert.equal(calls, 2);
});

test("invalid partial responses cannot supply retained decisions", async () => {
  const requests = [];
  await assert.rejects(
    classifyCommits([commit("a"), commit("b")], {
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return okResponse([
          { sha: "a", bump: "major", breakingUnits: [], summary: "A." },
        ]);
      },
    }),
    /Invalid bump for a/u,
  );
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].messages[1].content,
    requests[1].messages[1].content,
  );
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
