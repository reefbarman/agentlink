import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  classifyCommand,
  isCommandEligibleForReadOnlyExecution,
  type CommandTierContext,
} from "./commandClassifier.js";

describe("static binary file inspection", () => {
  let root: string;
  let outside: string;
  let ctx: CommandTierContext;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "command-inspection-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "command-outside-"));
    ctx = { cwd: root, workspaceRoots: [root] };
    fs.writeFileSync(
      path.join(root, "capture.bin"),
      Buffer.from([0, 1, 2, 255]),
    );
    fs.copyFileSync(
      path.join(root, "capture.bin"),
      path.join(root, "image file"),
    );
    fs.copyFileSync(
      path.join(root, "capture.bin"),
      path.join(outside, "image"),
    );
    fs.writeFileSync(path.join(root, ".env"), "secret");
    fs.symlinkSync(
      path.join(outside, "image"),
      path.join(root, "outside-link"),
    );
    fs.symlinkSync(path.join(root, ".env"), path.join(root, "secret-link"));
    fs.symlinkSync(
      path.join(root, "capture.bin"),
      path.join(root, "inside-link"),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it.runIf(process.platform === "darwin" && fs.existsSync("/usr/lib/dyld"))(
    "lets dyld_info, but not xxd, inspect Apple system images",
    () => {
      for (const command of [
        "dyld_info -uuid /usr/lib/dyld",
        "dyld_info -disassemble /usr/lib/dyld",
      ]) {
        expect(isCommandEligibleForReadOnlyExecution(command, ctx)).toEqual({
          eligible: true,
        });
      }
      for (const command of [
        "xxd -l 4 /usr/lib/dyld",
        "dyld_info -uuid /usr/lib",
        "dyld_info -uuid /usr/lib/../../etc/hosts",
        "dyld_info -uuid /usr/libexec/../lib/dyld/../../../etc/hosts",
        "dyld_info -uuid /System/Library",
      ]) {
        expect(
          isCommandEligibleForReadOnlyExecution(command, ctx).eligible,
        ).toBe(false);
      }
    },
  );

  it("rejects dyld_info through a workspace symlink to a non-system external file", () => {
    fs.symlinkSync("/etc/hosts", path.join(root, "hosts-link"));
    expect(
      isCommandEligibleForReadOnlyExecution("dyld_info -uuid hosts-link", ctx)
        .eligible,
    ).toBe(false);
  });

  it.each([
    "xxd -g 1 -l 512 capture.bin",
    "xxd -g 4 -s 172 -l 856 capture.bin",
    "xxd -l 65536 capture.bin",
    "xxd -l 0x10000 -s 0x10 -g 16 capture.bin",
    "xxd -g 8 -s 0 -l 1 capture.bin",
    "xxd -g 2 -l 1 inside-link",
    "xxd -l 4 'image file'",
    'xxd -l 4 "image file"',
    "dyld_info",
    "dyld_info -help",
    "dyld_info -disassemble capture.bin",
    "dyld_info -uuid capture.bin",
    "dyld_info -uuid -disassemble 'image file'",
  ])("allows narrowly scoped inspection: %s", (command) => {
    expect(classifyCommand(command, ctx).tier).toBe("safe");
    expect(isCommandEligibleForReadOnlyExecution(command, ctx)).toEqual({
      eligible: true,
    });
  });

  it.each([
    "xxd capture.bin",
    "xxd -l 4",
    "xxd -l 4 -",
    "xxd -r -l 4 capture.bin",
    "xxd -r -p -l 4 capture.bin",
    "xxd -l 4 capture.bin output.bin",
    "xxd -l 4 -o output.bin capture.bin",
    "xxd -l 4 -e capture.bin",
    "xxd -l 0 capture.bin",
    "xxd -l -1 capture.bin",
    "xxd -l +4 capture.bin",
    "xxd -l 65537 capture.bin",
    "xxd -l 0x10001 capture.bin",
    "xxd -l 010 capture.bin",
    "xxd -l 4 -l 65537 capture.bin",
    "xxd -l 4 -l 4 capture.bin",
    "xxd -l4 capture.bin",
    "xxd -l 4 -s -1 capture.bin",
    "xxd -l 4 -s +1 capture.bin",
    "xxd -l 4 -s 9007199254740992 capture.bin",
    "xxd -l 4 -s 0x20000000000000 capture.bin",
    "xxd -l 4 -g 0 capture.bin",
    "xxd -l 4 -g 3 capture.bin",
    "xxd -l 4 -g 32 capture.bin",
    "xxd -l 4 -g capture.bin",
    "xxd -l 4 missing.bin",
    "xxd -l 4 .",
    "xxd -l 4 '*.bin'",
    "xxd -l 4 capture*.bin",
    "xxd -l 4 capture\\.bin",
    "xxd -l 4 ' capture.bin'",
    "xxd -l 4 'capture.bin '",
    "xxd -l 4 \"'capture.bin'\"",
    "xxd -l 4 'image'\" file\"",
    "xxd -l 4 capture.bin > output.txt",
    "xxd -l 4 capture.bin < capture.bin",
    "xxd -l 4 $(echo capture.bin)",
    "/usr/bin/xxd -l 4 capture.bin",
    "./xxd -l 4 capture.bin",
    "dyld_info capture.bin",
    "dyld_info > output.txt",
    "dyld_info -help capture.bin",
    "dyld_info -disassemble",
    "dyld_info -disassemble capture.bin output.bin",
    "dyld_info -disassemble -disassemble capture.bin",
    "dyld_info -unknown capture.bin",
    "dyld_info -section __TEXT __text capture.bin",
    "dyld_info -disassemble missing.bin",
    "dyld_info -disassemble .",
    "dyld_info -disassemble -",
    "/usr/bin/dyld_info -help",
    "dyld_info -help > output.txt",
    "od -Ax -tx1 -N 512 capture.bin",
    "hexdump -C -n 512 capture.bin",
    "jq -r 'select(.event == \"resource\") | [.id, (.request_hex[176:192]), (.request_hex[192:208])] | @tsv' capture.bin",
  ])("keeps unsafe or unsupported forms blocked: %s", (command) => {
    expect(isCommandEligibleForReadOnlyExecution(command, ctx).eligible).toBe(
      false,
    );
    expect(classifyCommand(command, ctx).tier).not.toBe("safe");
  });

  it.each(["xxd -l 4", "dyld_info -disassemble", "dyld_info -uuid"])(
    "preserves external and secret path guards: %s",
    (prefix) => {
      for (const target of [path.join(outside, "image"), "outside-link"]) {
        const command = `${prefix} ${target}`;
        expect(
          classifyCommand(command, ctx).perSubCommand[0]?.result,
        ).toMatchObject({
          tier: "dangerous",
          code: "external_path",
        });
        expect(
          isCommandEligibleForReadOnlyExecution(command, ctx).eligible,
        ).toBe(false);
      }
      for (const target of [".env", "secret-link"]) {
        const command = `${prefix} ${target}`;
        expect(
          classifyCommand(command, ctx).perSubCommand[0]?.result,
        ).toMatchObject({
          tier: "dangerous",
          code: "secret_path",
        });
        expect(
          isCommandEligibleForReadOnlyExecution(command, ctx).eligible,
        ).toBe(false);
      }
    },
  );

  it("allows an absolute workspace file without relaxing executable paths", () => {
    expect(
      isCommandEligibleForReadOnlyExecution(
        `xxd -l 4 ${path.join(root, "capture.bin")}`,
        ctx,
      ),
    ).toEqual({ eligible: true });
  });
});
