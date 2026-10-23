import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  AskAgentCommandPolicy,
  isAskAgentCardRuleEntry,
} from "./AskAgentCommandPolicy.js";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function policyFile(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "al-cmd-policy-"));
  directories.push(directory);
  return path.join(directory, "policy.json");
}

const ROOT = "/work/app";
const OTHER = "/work/other";

describe("AskAgentCommandPolicy", () => {
  it("asks by default and offers each sub-command as a rule row", async () => {
    const policy = new AskAgentCommandPolicy({ filePath: await policyFile() });
    await expect(
      policy.evaluate({
        sessionId: "chat-1",
        root: ROOT,
        command: "npm test && git status",
      }),
    ).resolves.toEqual({
      decision: "ask",
      subCommands: [{ command: "npm test" }, { command: "git status" }],
    });
  });

  it("applies rules by chat, folder and all folders, and saves only the last two", async () => {
    const filePath = await policyFile();
    const policy = new AskAgentCommandPolicy({ filePath });
    await policy.saveCardRules({
      sessionId: "chat-1",
      root: ROOT,
      rules: [
        {
          pattern: "npm test",
          mode: "prefix",
          decision: "allow",
          scope: "session",
        },
        {
          pattern: "git status",
          mode: "exact",
          decision: "allow",
          scope: "project",
        },
        { pattern: "ls", mode: "prefix", decision: "allow", scope: "global" },
        {
          pattern: "ignored",
          mode: "prefix",
          decision: "allow",
          scope: "skip",
        },
      ],
    });
    const evaluate = (sessionId: string, root: string, command: string) =>
      policy.evaluate({ sessionId, root, command });

    await expect(
      evaluate("chat-1", ROOT, "npm test -- --run"),
    ).resolves.toEqual({ decision: "allow", by: "rule" });
    // Chat rules stay in that chat; folder rules stay in that folder.
    await expect(evaluate("chat-2", ROOT, "npm test")).resolves.toMatchObject({
      decision: "ask",
    });
    await expect(evaluate("chat-2", ROOT, "git status")).resolves.toMatchObject(
      {
        decision: "allow",
      },
    );
    await expect(
      evaluate("chat-2", OTHER, "git status"),
    ).resolves.toMatchObject({ decision: "ask" });
    await expect(evaluate("chat-2", OTHER, "ls -la")).resolves.toMatchObject({
      decision: "allow",
    });
    // Every segment must be allowed.
    await expect(
      evaluate("chat-2", OTHER, "ls && rm -rf build"),
    ).resolves.toMatchObject({
      decision: "ask",
      subCommands: [
        {
          command: "ls",
          existingRule: { pattern: "ls", scope: "global", decision: "allow" },
        },
        { command: "rm -rf build" },
      ],
    });

    const saved = JSON.parse(await fs.readFile(filePath, "utf8")) as {
      rules: Array<{ pattern: string; scope: string; root?: string }>;
    };
    expect(
      saved.rules.map(({ pattern, scope, root }) => ({ pattern, scope, root })),
    ).toEqual([
      { pattern: "git status", scope: "project", root: ROOT },
      { pattern: "ls", scope: "global", root: undefined },
    ]);
    const reloaded = new AskAgentCommandPolicy({ filePath });
    await expect(
      reloaded.evaluate({
        sessionId: "chat-1",
        root: ROOT,
        command: "npm test",
      }),
    ).resolves.toMatchObject({ decision: "ask" });
    await expect(
      reloaded.evaluate({
        sessionId: "chat-9",
        root: ROOT,
        command: "git status",
      }),
    ).resolves.toMatchObject({ decision: "allow" });
  });

  it("runs everything under Approve for Me except Prompt and Forbidden matches", async () => {
    const filePath = await policyFile();
    const policy = new AskAgentCommandPolicy({ filePath });
    await policy.setApproveForMe(true);
    await policy.saveCardRules({
      sessionId: "chat-1",
      root: ROOT,
      rules: [
        {
          pattern: "git push",
          mode: "prefix",
          decision: "prompt",
          scope: "global",
        },
        {
          pattern: "rm",
          mode: "prefix",
          decision: "forbidden",
          scope: "global",
        },
      ],
    });
    const evaluate = (command: string) =>
      policy.evaluate({ sessionId: "chat-1", root: ROOT, command });

    await expect(evaluate("npm run build")).resolves.toEqual({
      decision: "allow",
      by: "approve-for-me",
    });
    await expect(evaluate("git push origin main")).resolves.toMatchObject({
      decision: "ask",
    });
    await expect(evaluate("ls && rm -rf dist")).resolves.toEqual({
      decision: "forbidden",
    });
    expect(
      (await new AskAgentCommandPolicy({ filePath }).snapshot()).approveForMe,
    ).toBe(true);

    await policy.setApproveForMe(false);
    await expect(evaluate("npm run build")).resolves.toMatchObject({
      decision: "ask",
    });
  });

  it("removes rules and forgets a deleted chat's rules", async () => {
    const policy = new AskAgentCommandPolicy({ filePath: await policyFile() });
    await policy.saveCardRules({
      sessionId: "chat-1",
      root: ROOT,
      rules: [
        { pattern: "make", mode: "prefix", decision: "allow", scope: "global" },
        { pattern: "pwd", mode: "exact", decision: "allow", scope: "session" },
      ],
    });
    const [sessionRule, globalRule] = (await policy.snapshot("chat-1")).rules;
    expect(sessionRule).toMatchObject({ pattern: "pwd", scope: "session" });
    expect(await policy.removeRule(globalRule!.id)).toBe(true);
    expect(await policy.removeRule("missing")).toBe(false);
    policy.clearSession("chat-1");
    expect((await policy.snapshot("chat-1")).rules).toEqual([]);
  });

  it("ignores a damaged policy file and rejects malformed card rules", async () => {
    const filePath = await policyFile();
    await fs.writeFile(filePath, "{not json");
    const policy = new AskAgentCommandPolicy({ filePath });
    await expect(policy.snapshot()).resolves.toEqual({
      approveForMe: false,
      rules: [],
      destinations: [],
    });
    expect(
      isAskAgentCardRuleEntry({ pattern: "(", mode: "regex", scope: "global" }),
    ).toBe(false);
    expect(
      isAskAgentCardRuleEntry({
        pattern: "x",
        mode: "prefix",
        scope: "machine",
      }),
    ).toBe(false);
    expect(
      isAskAgentCardRuleEntry({ pattern: "", mode: "skip", scope: "skip" }),
    ).toBe(true);
  });

  it("refuses regex rules that can backtrack catastrophically", () => {
    const regex = (pattern: string) =>
      isAskAgentCardRuleEntry({ pattern, mode: "regex", scope: "global" });
    expect(regex("^npm (test|run lint)$")).toBe(true);
    expect(regex("^git (status|diff)( --stat)?$")).toBe(true);
    expect(regex("^ls( -[a-z]+)?$")).toBe(true);
    expect(regex("(a+)+$")).toBe(false);
    expect(regex("^(\\w+\\s?)*$")).toBe(false);
    expect(regex("((ab)*){2,}")).toBe(false);
  });

  it("changes nothing when saving the policy fails", async () => {
    // The policy path is a directory, so the atomic rename fails.
    const directory = path.dirname(await policyFile());
    const filePath = path.join(directory, "occupied");
    await fs.mkdir(filePath);
    const policy = new AskAgentCommandPolicy({ filePath });

    await expect(policy.setApproveForMe(true)).rejects.toThrow();
    await expect(
      policy.saveCardRules({
        sessionId: "chat-1",
        root: ROOT,
        rules: [
          {
            pattern: "npm",
            mode: "prefix",
            decision: "allow",
            scope: "global",
          },
          {
            pattern: "ls",
            mode: "prefix",
            decision: "allow",
            scope: "session",
          },
        ],
      }),
    ).rejects.toThrow();
    await expect(policy.snapshot("chat-1")).resolves.toEqual({
      approveForMe: false,
      rules: [],
      destinations: [],
    });
    await expect(
      policy.evaluate({ sessionId: "chat-1", root: ROOT, command: "npm test" }),
    ).resolves.toMatchObject({ decision: "ask" });
  });

  it("allows exact destinations by chat, folder and all folders", async () => {
    const filePath = await policyFile();
    const policy = new AskAgentCommandPolicy({ filePath });
    const npm = {
      protocol: "https" as const,
      host: "Registry.NPMjs.org",
      port: 443,
    };
    const allowed = (sessionId: string, root: string, destination = npm) =>
      policy.isDestinationAllowed({ sessionId, root, ...destination });

    await expect(allowed("chat-1", ROOT)).resolves.toBe(false);
    await policy.saveDestination({
      sessionId: "chat-1",
      root: ROOT,
      ...npm,
      scope: "session",
    });
    await expect(allowed("chat-1", OTHER)).resolves.toBe(true);
    await expect(allowed("chat-2", ROOT)).resolves.toBe(false);

    await policy.saveDestination({
      sessionId: "chat-1",
      root: ROOT,
      protocol: "https",
      host: "pypi.org",
      port: 443,
      scope: "project",
    });
    const pypi = { protocol: "https" as const, host: "pypi.org", port: 443 };
    await expect(allowed("chat-2", ROOT, pypi)).resolves.toBe(true);
    await expect(allowed("chat-2", OTHER, pypi)).resolves.toBe(false);
    // Port and protocol must match exactly.
    await expect(
      allowed("chat-2", ROOT, { ...pypi, port: 8443 }),
    ).resolves.toBe(false);

    await policy.saveDestination({
      sessionId: "chat-1",
      root: ROOT,
      ...npm,
      scope: "global",
    });
    await expect(allowed("chat-9", OTHER)).resolves.toBe(true);

    // Saved rules survive a restart; chat rules do not.
    const reloaded = new AskAgentCommandPolicy({ filePath });
    const snapshot = await reloaded.snapshot("chat-1");
    expect(snapshot.destinations.map((rule) => rule.scope).sort()).toEqual([
      "global",
      "project",
    ]);
    expect(snapshot.destinations[0]!.host).toBe("pypi.org");
    const global = snapshot.destinations.find(
      (rule) => rule.scope === "global",
    )!;
    expect(global.host).toBe("registry.npmjs.org");
    await expect(reloaded.removeRule(global.id)).resolves.toBe(true);
    await expect(
      reloaded.isDestinationAllowed({
        sessionId: "chat-9",
        root: OTHER,
        ...npm,
      }),
    ).resolves.toBe(false);
  });

  it("refuses malformed destinations", async () => {
    const policy = new AskAgentCommandPolicy({ filePath: await policyFile() });
    await expect(
      policy.saveDestination({
        sessionId: "chat-1",
        root: ROOT,
        protocol: "https",
        host: "bad host/path",
        port: 443,
        scope: "global",
      }),
    ).rejects.toThrow("destination_rule_invalid");
    await expect(
      policy.saveDestination({
        sessionId: "chat-1",
        root: ROOT,
        protocol: "https",
        host: "example.com",
        port: 70_000,
        scope: "global",
      }),
    ).rejects.toThrow("destination_rule_invalid");
  });
});
