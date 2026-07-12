import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  writeAtomicJsonFile,
  type AtomicFileOperations,
} from "./atomicJsonFile.js";

function realOperations(
  overrides: Partial<AtomicFileOperations> = {},
): AtomicFileOperations {
  return {
    mkdirSync: (target, options) => fs.mkdirSync(target, options),
    openSync: (target, flags) => fs.openSync(target, flags),
    writeFileSync: (file, data, options) =>
      fs.writeFileSync(file, data, options),
    fsyncSync: (fd) => fs.fsyncSync(fd),
    closeSync: (fd) => fs.closeSync(fd),
    renameSync: (oldPath, newPath) => fs.renameSync(oldPath, newPath),
    rmSync: (target, options) => fs.rmSync(target, options),
    ...overrides,
  };
}

describe("writeAtomicJsonFile", () => {
  let temporaryDirectory: string;
  let targetPath: string;

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "atomic-json-file-"),
    );
    targetPath = path.join(temporaryDirectory, "nested", "cache.json");
  });

  afterEach(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("replaces the target and fsyncs the file before rename and directory after", () => {
    const events: string[] = [];
    const operations = realOperations({
      openSync: (target, flags) => {
        const isDirectory = String(target) === path.dirname(targetPath);
        events.push(isDirectory ? "open-directory" : "open-temporary");
        return fs.openSync(target, flags);
      },
      writeFileSync: (file, data, options) => {
        events.push("write-temporary");
        fs.writeFileSync(file, data, options);
      },
      fsyncSync: (fd) => {
        events.push(
          events.includes("open-directory")
            ? "fsync-directory"
            : "fsync-temporary",
        );
        fs.fsyncSync(fd);
      },
      closeSync: (fd) => {
        events.push(
          events.includes("open-directory")
            ? "close-directory"
            : "close-temporary",
        );
        fs.closeSync(fd);
      },
      renameSync: (oldPath, newPath) => {
        events.push("rename");
        fs.renameSync(oldPath, newPath);
      },
    });

    writeAtomicJsonFile(targetPath, { version: 1 }, operations);

    expect(JSON.parse(fs.readFileSync(targetPath, "utf8"))).toEqual({
      version: 1,
    });
    expect(events).toEqual([
      "open-temporary",
      "write-temporary",
      "fsync-temporary",
      "close-temporary",
      "rename",
      "open-directory",
      "fsync-directory",
      "close-directory",
    ]);
    expect(listTemporaryFiles(targetPath)).toEqual([]);
  });

  it.each(["write", "file fsync", "rename"])(
    "preserves the previous target and removes the temporary file when %s fails",
    (failure) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, JSON.stringify({ version: "old" }));
      let fsyncCalls = 0;
      const operations = realOperations({
        writeFileSync: (file, data, options) => {
          fs.writeFileSync(file, data, options);
          if (failure === "write") throw new Error("injected write failure");
        },
        fsyncSync: (fd) => {
          fsyncCalls++;
          if (failure === "file fsync" && fsyncCalls === 1) {
            throw new Error("injected file fsync failure");
          }
          fs.fsyncSync(fd);
        },
        renameSync: (oldPath, newPath) => {
          if (failure === "rename") throw new Error("injected rename failure");
          fs.renameSync(oldPath, newPath);
        },
      });

      expect(() =>
        writeAtomicJsonFile(targetPath, { version: "new" }, operations),
      ).toThrow(`injected ${failure} failure`);
      expect(JSON.parse(fs.readFileSync(targetPath, "utf8"))).toEqual({
        version: "old",
      });
      expect(listTemporaryFiles(targetPath)).toEqual([]);
    },
  );

  it("reports a directory fsync failure after replacement without leaking a temp file", () => {
    let fsyncCalls = 0;
    const operations = realOperations({
      fsyncSync: (fd) => {
        fsyncCalls++;
        if (fsyncCalls === 2)
          throw new Error("injected directory fsync failure");
        fs.fsyncSync(fd);
      },
    });

    expect(() =>
      writeAtomicJsonFile(targetPath, { version: "new" }, operations),
    ).toThrow("injected directory fsync failure");
    expect(JSON.parse(fs.readFileSync(targetPath, "utf8"))).toEqual({
      version: "new",
    });
    expect(listTemporaryFiles(targetPath)).toEqual([]);
  });

  it.each(["EINVAL", "EPERM", "EISDIR", "ENOTSUP"])(
    "accepts an atomic replacement when Windows cannot open a directory with %s",
    (code) => {
      const operations = realOperations({
        openSync: (target, flags) => {
          if (String(target) === path.dirname(targetPath)) {
            throw Object.assign(new Error("directory open unsupported"), {
              code,
            });
          }
          return fs.openSync(target, flags);
        },
      });

      expect(() =>
        writeAtomicJsonFile(
          targetPath,
          { version: "new" },
          operations,
          "win32",
        ),
      ).not.toThrow();
      expect(JSON.parse(fs.readFileSync(targetPath, "utf8"))).toEqual({
        version: "new",
      });
      expect(listTemporaryFiles(targetPath)).toEqual([]);
    },
  );

  it("does not tolerate a directory fsync permission failure", () => {
    let fsyncCalls = 0;
    const operations = realOperations({
      fsyncSync: (fd) => {
        fsyncCalls++;
        if (fsyncCalls === 2) {
          throw Object.assign(new Error("directory fsync denied"), {
            code: "EPERM",
          });
        }
        fs.fsyncSync(fd);
      },
    });

    expect(() =>
      writeAtomicJsonFile(targetPath, { version: "new" }, operations, "win32"),
    ).toThrow("directory fsync denied");
  });

  it("preserves a directory fsync failure when descriptor close also fails", () => {
    let fsyncCalls = 0;
    let closeCalls = 0;
    const operations = realOperations({
      fsyncSync: (fd) => {
        fsyncCalls++;
        if (fsyncCalls === 2) throw new Error("directory fsync failed");
        fs.fsyncSync(fd);
      },
      closeSync: (fd) => {
        closeCalls++;
        if (closeCalls === 2) {
          fs.closeSync(fd);
          throw new Error("directory close failed");
        }
        fs.closeSync(fd);
      },
    });

    expect(() =>
      writeAtomicJsonFile(targetPath, { version: "new" }, operations),
    ).toThrow("directory fsync failed");
  });

  it("does not remove a colliding temporary path it did not create", () => {
    let collisionPath = "";
    const operations = realOperations({
      openSync: (target, flags) => {
        if (String(target) !== path.dirname(targetPath)) {
          collisionPath = String(target);
          fs.mkdirSync(path.dirname(collisionPath), { recursive: true });
          fs.writeFileSync(collisionPath, "owned by another writer");
          throw Object.assign(new Error("temporary path collision"), {
            code: "EEXIST",
          });
        }
        return fs.openSync(target, flags);
      },
    });

    expect(() =>
      writeAtomicJsonFile(targetPath, { version: "new" }, operations),
    ).toThrow("temporary path collision");
    expect(fs.readFileSync(collisionPath, "utf8")).toBe(
      "owned by another writer",
    );
  });

  it("serializes before creating a temporary file", () => {
    expect(() => writeAtomicJsonFile(targetPath, { value: 1n })).toThrow();
    expect(fs.existsSync(path.dirname(targetPath))).toBe(false);
  });

  it("uses exclusive unique temporary files for sequential checkpoints", () => {
    writeAtomicJsonFile(targetPath, { revision: 1 });
    writeAtomicJsonFile(targetPath, { revision: 2 });

    expect(JSON.parse(fs.readFileSync(targetPath, "utf8"))).toEqual({
      revision: 2,
    });
    expect(listTemporaryFiles(targetPath)).toEqual([]);
  });
});

function listTemporaryFiles(targetPath: string): string[] {
  const directory = path.dirname(targetPath);
  if (!fs.existsSync(directory)) return [];
  const prefix = `.${path.basename(targetPath)}.tmp-`;
  return fs.readdirSync(directory).filter((entry) => entry.startsWith(prefix));
}
