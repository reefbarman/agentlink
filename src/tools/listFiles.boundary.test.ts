import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { handleListFiles } from "./listFiles.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("child_process", async () => ({
  ...(await vi.importActual<typeof import("child_process")>("child_process")),
  spawn,
}));
vi.mock("../util/ripgrep.js", async () => ({
  ...(await vi.importActual<typeof import("../util/ripgrep.js")>(
    "../util/ripgrep.js",
  )),
  getRipgrepBinPath: async () => "rg",
}));
vi.mock("../services/semanticSearch.js", () => ({ semanticFileList: vi.fn() }));

describe("listing to ripgrep process boundary", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "list-files-boundary-"));
    spawn.mockReset();
    spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        child.stdout.end("./nested/index.js\n./README.md\n");
        child.stderr.end();
        setImmediate(() => child.emit("close", 0));
      });
      return child;
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([false, true])(
    "forwards an explicit dependency root as cwd, include_ignored=%s",
    async (includeIgnored) => {
      const target = path.join(
        root,
        "node_modules",
        "@example",
        "package",
        "dist",
      );
      await fs.mkdir(target, { recursive: true });
      const result = await handleListFiles(
        {
          path: target,
          recursive: true,
          depth: 2,
          include_ignored: includeIgnored,
        },
        {} as never,
        {} as never,
        "boundary-test",
        {
          workspaceFileProvider: {
            resolvePath: () => ({ absolutePath: target, inWorkspace: true }),
          },
          pathAccessProvider: {
            ensureAccess: async () => ({ approved: true }),
          },
        },
      );
      expect(spawn).toHaveBeenCalledOnce();
      const [executable, args, options] = spawn.mock.calls[0]!;
      expect(executable).toBe("rg");
      expect(options).toEqual({ cwd: target });
      expect(args.at(-1)).toBe(".");
      expect(args).not.toContain(target);
      expect(args).toContain("--no-ignore-parent");
      expect(args).toContain("!**/node_modules/**");
      expect(args).toContain("!**/.git/**");
      expect(args.includes("--no-ignore")).toBe(includeIgnored);
      expect(result.data).toMatchObject({
        count: 2,
        entries: "README.md\nnested/index.js",
        truncated: false,
      });
    },
  );

  it("does not disable parent ignore rules for ordinary directory roots", async () => {
    const result = await handleListFiles(
      { path: root, recursive: true },
      {} as never,
      {} as never,
      "boundary-test",
      {
        workspaceFileProvider: {
          resolvePath: () => ({ absolutePath: root, inWorkspace: true }),
        },
        pathAccessProvider: { ensureAccess: async () => ({ approved: true }) },
      },
    );
    expect(spawn.mock.calls[0]![1]).not.toContain("--no-ignore-parent");
    expect(result.isError).toBe(false);
  });
});
