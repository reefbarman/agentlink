import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { build } from "esbuild";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

interface FixtureMessage {
  type: "acquired" | "mutated" | "fenced" | "error";
  fenceToken?: string;
  value?: string;
  message?: string;
}

const TEST_TIMEOUT_MS = 60_000;
let buildRoot: string;
let fixturePath: string;

beforeAll(async () => {
  buildRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentlink-index-writer-process-fixture-"),
  );
  fixturePath = path.join(buildRoot, "index-writer-process-fixture.cjs");
  await build({
    entryPoints: [
      path.resolve(
        "src/indexer/fixtures/codeIndexWriterLeaseProcessFixture.ts",
      ),
    ],
    bundle: true,
    outfile: fixturePath,
    format: "cjs",
    platform: "node",
    target: "node22",
  });
}, TEST_TIMEOUT_MS);

afterAll(() => {
  fs.rmSync(buildRoot, { recursive: true, force: true });
});

describe("code index writer lease process fencing", () => {
  it(
    "rejects a paused writer after a successor takes over",
    async () => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "agentlink-index-writer-process-"),
      );
      const storeRoot = path.join(directory, "store");
      const children: ChildProcess[] = [];
      onTestFinished(async () => {
        await Promise.all(children.map(stopChild));
        fs.rmSync(directory, { recursive: true, force: true });
      });

      const first = startFixture();
      children.push(first.child);
      first.child.send({
        type: "start",
        storeRoot,
        workspaceScopeId: "workspace:abc123",
        ownerId: "window-1:job-1",
        staleMs: 150,
      });
      expect(await first.waitFor("acquired")).toMatchObject({
        fenceToken: "1",
      });

      await pause(200);
      const second = startFixture();
      children.push(second.child);
      second.child.send({
        type: "start",
        storeRoot,
        workspaceScopeId: "workspace:abc123",
        ownerId: "window-2:job-2",
        staleMs: 150,
      });
      expect(await second.waitFor("acquired")).toMatchObject({
        fenceToken: "2",
      });

      second.child.send({ type: "mutate", value: "successor" });
      expect(await second.waitFor("mutated")).toMatchObject({
        value: "successor",
        fenceToken: "2",
      });

      first.child.send({ type: "mutate", value: "stale" });
      expect(await first.waitFor("fenced")).toMatchObject({
        message: "code_index_writer_fenced",
        fenceToken: "1",
      });
    },
    TEST_TIMEOUT_MS,
  );
});

function startFixture(): {
  child: ChildProcess;
  waitFor(type: FixtureMessage["type"]): Promise<FixtureMessage>;
} {
  const child = fork(fixturePath, [], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_PATH: path.resolve("node_modules") },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: FixtureMessage[] = [];
  const errors: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk.toString()));
  child.on("message", (message: FixtureMessage) => messages.push(message));

  return {
    child,
    waitFor(type) {
      const existing = messages.findIndex((message) => message.type === type);
      if (existing >= 0)
        return Promise.resolve(messages.splice(existing, 1)[0]!);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(
            new Error(
              `Timed out waiting for ${type}; stderr=${errors.join("")}; messages=${JSON.stringify(messages)}`,
            ),
          );
        }, TEST_TIMEOUT_MS);
        const onMessage = (message: FixtureMessage) => {
          if (message.type === "error") {
            cleanup();
            reject(new Error(message.message ?? "Fixture failed"));
            return;
          }
          if (message.type !== type) return;
          cleanup();
          const index = messages.indexOf(message);
          if (index >= 0) messages.splice(index, 1);
          resolve(message);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          cleanup();
          reject(
            new Error(
              `Fixture exited before ${type}: code=${code} signal=${signal}; stderr=${errors.join("")}`,
            ),
          );
        };
        const cleanup = () => {
          clearTimeout(timeout);
          child.off("message", onMessage);
          child.off("exit", onExit);
        };
        child.on("message", onMessage);
        child.on("exit", onExit);
      });
    },
  };
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 1_000);
    timeout.unref();
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
}
