import { describe, expect, it, vi } from "vitest";

import { createNodeHostCommandTools } from "./commandTools.js";

const principal = { tenantId: "tenant-a", subjectId: "subject-a" };
const cwd = process.cwd();

function context(overrides = {}) {
  return {
    principal,
    sessionId: "session-a",
    turnId: "turn-a",
    model: {
      model: { providerId: "fixture", modelId: "fixture-model" },
      source: "runtime" as const,
    },
    signal: undefined,
    ...overrides,
  };
}

function nodeCommand(id: string, source: string, overrides = {}) {
  return {
    id,
    command: process.execPath,
    args: ["-e", source],
    cwd,
    env: { C6_FIXTURE: "host-supplied" },
    ...overrides,
  };
}

async function commandTool(
  resolver: ReturnType<typeof createNodeHostCommandTools>,
  id: string,
) {
  const tools = await resolver({
    principal,
    sessionId: "session-a",
    turnId: "turn-a",
  });
  const tool = tools.find(
    (candidate) => candidate.definition.name === `command_${id}`,
  );
  if (!tool) throw new Error(`Missing command_${id}`);
  return tool;
}

describe("node host command tools", () => {
  it("requires explicit host authorization and uses only the supplied command environment", async () => {
    const command = nodeCommand(
      "env",
      'process.stdout.write(`${process.env.C6_FIXTURE}|${process.env.HOME ?? "missing"}`)',
    );
    const resolveCommands = vi.fn(async () => [command]);
    const authorizeLaunch = vi.fn(async () => true);
    const resolver = createNodeHostCommandTools({
      resolveCommands,
      authorizeLaunch,
    });
    const tool = await commandTool(resolver, "env");

    expect(tool).toMatchObject({
      effect: "external",
      authorization: "required",
      definition: { name: "command_env" },
    });
    expect(resolveCommands).toHaveBeenCalledWith({
      principal,
      sessionId: "session-a",
      turnId: "turn-a",
    });
    await expect(tool.execute({}, context())).resolves.toMatchObject({
      modelContent: expect.stringContaining("host-supplied|missing"),
      displayContent: { command: "env", exitCode: 0 },
    });
    expect(authorizeLaunch).toHaveBeenCalledTimes(2);
  });

  it("fails closed for denied or incomplete commands and mismatched invocation turns", async () => {
    const command = nodeCommand("fixture", 'process.stdout.write("ok")');
    const denied = createNodeHostCommandTools({
      resolveCommands: () => [command],
      authorizeLaunch: () => false,
    });
    await expect(
      denied({ principal, sessionId: "session-a", turnId: "turn-a" }),
    ).resolves.toEqual([]);

    const incomplete = createNodeHostCommandTools({
      resolveCommands: () => [
        { ...command, id: "relative", command: "node" },
        { ...command, id: "cwd", cwd: "relative" },
        { ...command, id: "args", args: undefined as never },
        { ...command, id: "env", env: { BAD: "x\0y" } },
      ],
      authorizeLaunch: () => true,
    });
    await expect(
      incomplete({ principal, sessionId: "session-a", turnId: "turn-a" }),
    ).resolves.toEqual([]);

    const resolver = createNodeHostCommandTools({
      resolveCommands: () => [command],
      authorizeLaunch: () => true,
    });
    const tool = await commandTool(resolver, "fixture");
    await expect(
      tool.execute(
        {},
        context({
          principal: { tenantId: "tenant-b", subjectId: "subject-b" },
        }),
      ),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: expect.stringContaining("command_turn_mismatch"),
    });
  });

  it("bounds output and reports a nonzero command result without retaining a terminal", async () => {
    const resolver = createNodeHostCommandTools({
      resolveCommands: () => [
        nodeCommand("bound", 'process.stdout.write("0123456789")', {
          maxOutputChars: 5,
        }),
        nodeCommand(
          "failure",
          'process.stderr.write("failed"); process.exit(3)',
        ),
      ],
      authorizeLaunch: () => true,
      maxOutputChars: 10,
    });
    const bounded = await commandTool(resolver, "bound");
    const failure = await commandTool(resolver, "failure");

    await expect(bounded.execute({}, context())).resolves.toMatchObject({
      modelContent: expect.stringContaining('"output":"01234"'),
      displayContent: { command: "bound", exitCode: 0, outputTruncated: true },
    });
    await expect(failure.execute({}, context())).resolves.toMatchObject({
      isError: true,
      modelContent: expect.stringContaining('"exitCode":3'),
      displayContent: { command: "failure", exitCode: 3 },
    });
  });

  it("enforces a fixed timeout and terminates a non-cooperative child", async () => {
    const resolver = createNodeHostCommandTools({
      resolveCommands: () => [
        nodeCommand("timeout", "setTimeout(() => {}, 10_000)", {
          timeoutMs: 20,
        }),
      ],
      authorizeLaunch: () => true,
    });
    const tool = await commandTool(resolver, "timeout");

    await expect(tool.execute({}, context())).resolves.toMatchObject({
      isError: true,
      modelContent: expect.stringContaining('"timedOut":true'),
      displayContent: { command: "timeout", timedOut: true },
    });
  });

  it("forwards cancellation to the non-PTY child", async () => {
    const controller = new AbortController();
    const resolver = createNodeHostCommandTools({
      resolveCommands: () => [
        nodeCommand("wait", "setTimeout(() => {}, 10_000)"),
      ],
      authorizeLaunch: () => true,
    });
    const tool = await commandTool(resolver, "wait");
    const execution = tool.execute({}, context({ signal: controller.signal }));
    controller.abort();

    await expect(execution).resolves.toMatchObject({
      isError: true,
      modelContent: expect.stringContaining('"cancelled":true'),
      displayContent: { command: "wait", cancelled: true },
    });
  });
});
