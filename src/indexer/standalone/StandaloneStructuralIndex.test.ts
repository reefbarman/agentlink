import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { StandaloneStructuralIndex } from "./StandaloneStructuralIndex.js";
import {
  createStructuralIndexTools,
  createVisibility,
  projectVisibleGraph,
  type StructuralIndexScope,
} from "./structuralIndexTools.js";

const roots: string[] = [];

function fixture(files: Record<string, string>): {
  project: string;
  indexRoot: string;
} {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "structural-index-")),
  );
  roots.push(base);
  const project = path.join(base, "project");
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), content);
  }
  return { project, indexRoot: path.join(base, "index") };
}

/** Walk the fixture (no git in temp dirs). */
const walk = async (root: string) => {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(root, dir), {
      withFileTypes: true,
    })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(rel);
      else out.push(rel);
    }
  };
  visit("");
  return out;
};

function index(project: string, indexRoot: string, waitForWriterMs = 5_000) {
  return new StandaloneStructuralIndex({
    projectRoot: project,
    indexRoot,
    listFiles: walk,
    waitForWriterMs,
  });
}

/** Bump mtime so a same-size edit is still seen as a change. */
function touch(file: string, content: string) {
  fs.writeFileSync(file, content);
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(file, later, later);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("StandaloneStructuralIndex", () => {
  it("builds a graph with imports, exports and dependents, then publishes it", async () => {
    const { project, indexRoot } = fixture({
      "src/a.ts": 'import { b } from "./b";\nexport const a = b;\n',
      "src/b.ts": "export const b = 1;\n",
      "README.md": "# hi\n",
    });
    const read = await index(project, indexRoot).read();
    expect(read.state).toBe("fresh");
    expect(Object.keys(read.graph.files).sort()).toEqual([
      "README.md",
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(read.graph.files["src/a.ts"]!.imports[0]).toMatchObject({
      specifier: "./b",
      resolvedRelPath: "src/b.ts",
    });
    expect(fs.existsSync(path.join(read.storePath, "snapshot.json"))).toBe(
      true,
    );
  });

  it("shares one published generation between clients of the same checkout", async () => {
    const { project, indexRoot } = fixture({ "a.ts": "export const a = 1;\n" });
    const first = await index(project, indexRoot).read();
    const second = await index(project, indexRoot).read();
    expect(second.generation).toBe(first.generation);
    expect(second.storePath).toBe(first.storePath);
  });

  it("re-extracts only changed files and re-resolves importers of added or removed files", async () => {
    const { project, indexRoot } = fixture({
      "a.ts": 'import { b } from "./b";\n',
      "c.ts": "export const c = 1;\n",
    });
    const before = await index(project, indexRoot).read();
    expect(before.graph.files["a.ts"]!.imports[0]!.resolvedRelPath).toBe(
      undefined,
    );
    const cIndexedAt = before.graph.files["c.ts"]!.indexedAt;

    fs.writeFileSync(path.join(project, "b.ts"), "export const b = 2;\n");
    const added = await index(project, indexRoot).read();
    expect(added.generation).not.toBe(before.generation);
    expect(added.graph.files["a.ts"]!.imports[0]!.resolvedRelPath).toBe("b.ts");
    expect(added.graph.files["c.ts"]!.indexedAt).toBe(cIndexedAt);

    fs.rmSync(path.join(project, "b.ts"));
    const removed = await index(project, indexRoot).read();
    expect(removed.graph.files["b.ts"]).toBeUndefined();
    expect(removed.graph.files["a.ts"]!.imports[0]!.resolvedRelPath).toBe(
      undefined,
    );

    touch(path.join(project, "c.ts"), "export const d = 1;\n");
    const edited = await index(project, indexRoot).read();
    expect(edited.graph.files["c.ts"]!.exports.map((e) => e.name)).toEqual([
      "d",
    ]);
  });

  it("does not rebuild for files it cannot extract", async () => {
    const { project, indexRoot } = fixture({
      "a.ts": "export const a = 1;\n",
      "bin.json": "\0\0binary",
    });
    const first = await index(project, indexRoot).read();
    const second = await index(project, indexRoot).read();
    expect(second.generation).toBe(first.generation);
    expect(first.graph.files["bin.json"]).toBeUndefined();
  });

  it("never indexes symlinks", async () => {
    const { project, indexRoot } = fixture({ "a.ts": "export const a = 1;\n" });
    const outside = path.join(path.dirname(project), "secret.ts");
    fs.writeFileSync(outside, "export const secret = 1;\n");
    fs.symlinkSync(outside, path.join(project, "link.ts"));
    const read = await index(project, indexRoot).read();
    expect(Object.keys(read.graph.files)).toEqual(["a.ts"]);
  });

  it("lets one writer build while a concurrent client waits for its generation", async () => {
    const { project, indexRoot } = fixture(
      Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [
          `f${i}.ts`,
          `export const v${i} = ${i};\n`,
        ]),
      ),
    );
    const [one, two] = await Promise.all([
      index(project, indexRoot).read(),
      index(project, indexRoot).read(),
    ]);
    expect(one.state).toBe("fresh");
    expect(two.state).toBe("fresh");
    expect(Object.keys(one.graph.files)).toHaveLength(40);
    expect(Object.keys(two.graph.files)).toHaveLength(40);
  });

  it("rebuilds an incompatible snapshot instead of trusting it", async () => {
    const { project, indexRoot } = fixture({ "a.ts": "export const a = 1;\n" });
    const first = await index(project, indexRoot).read();
    fs.writeFileSync(
      path.join(first.storePath, "snapshot.json"),
      JSON.stringify({ storeVersion: 99, files: {} }),
    );
    const read = await index(project, indexRoot).read();
    expect(read.generation).not.toBe(first.generation);
    expect(Object.keys(read.graph.files)).toEqual(["a.ts"]);
  });
});

describe("scoped structural tools", () => {
  const principal = { tenantId: "t", subjectId: "s" } as never;

  async function call(
    project: string,
    indexRoot: string,
    scopes: StructuralIndexScope[],
    name: string,
    input: Record<string, unknown>,
  ) {
    const tools = await createStructuralIndexTools({
      index: index(project, indexRoot),
      resolveScopes: async () => scopes,
    })({} as never);
    const tool = tools.find((candidate) => candidate.definition.name === name)!;
    expect(tool.authorization).toBe("none");
    const result = await tool.execute(input, {
      principal,
      sessionId: "s1",
      turnId: "t1",
      model: { model: { providerId: "p", modelId: "m" }, source: "session" },
    } as never);
    return {
      result,
      payload: result.isError
        ? undefined
        : (JSON.parse(String(result.modelContent)) as Record<string, unknown>),
    };
  }

  it("maps the visible project and reports the index generation", async () => {
    const { project, indexRoot } = fixture({
      "src/a.ts": 'import { b } from "./b";\n',
      "src/b.ts": "export const b = 1;\n",
    });
    const { payload } = await call(
      project,
      indexRoot,
      [{ path: ".", kind: "directory", access: "read_write" }],
      "get_repo_map",
      {},
    );
    expect(JSON.stringify(payload)).toContain("src/a.ts");
    expect(payload!.index).toMatchObject({ state: "fresh" });
  });

  it("hides files and links outside a narrower scope", async () => {
    const { project, indexRoot } = fixture({
      "public/a.ts": 'import { s } from "../secret/s";\nexport const a = s;\n',
      "secret/s.ts": "export const s = 1;\n",
    });
    const scopes: StructuralIndexScope[] = [
      { path: "public", kind: "directory", access: "read" },
    ];
    const map = await call(project, indexRoot, scopes, "get_repo_map", {});
    expect(JSON.stringify(map.payload)).not.toContain("secret/s.ts");

    const neighbors = await call(
      project,
      indexRoot,
      scopes,
      "get_module_neighbors",
      { path: "public/a.ts" },
    );
    expect(JSON.stringify(neighbors.payload)).not.toContain("secret/s.ts");

    const hidden = await call(
      project,
      indexRoot,
      scopes,
      "get_module_neighbors",
      { path: "secret/s.ts" },
    );
    expect(hidden.result).toMatchObject({
      isError: true,
      modelContent: "path_not_scoped",
    });
  });

  it("refuses paths outside the project", async () => {
    const { project, indexRoot } = fixture({ "a.ts": "export const a = 1;\n" });
    const { result } = await call(
      project,
      indexRoot,
      [{ path: ".", kind: "directory" }],
      "get_repo_map",
      { path: "../" },
    );
    expect(result.isError).toBe(true);
  });

  it("ignores write-only scopes for visibility", async () => {
    const { project } = fixture({ "a.ts": "" });
    const isVisible = await createVisibility(fs.realpathSync(project), [
      { path: ".", kind: "directory", access: "write" },
    ]);
    expect(isVisible("a.ts")).toBe(false);
    const graph = projectVisibleGraph(
      {
        version: 1,
        workspaceRoot: project,
        generatedAt: "",
        files: {
          "a.ts": {
            relPath: "a.ts",
            hash: "h",
            indexedAt: "",
            imports: [],
            exports: [],
            symbols: [],
          },
        },
      },
      isVisible,
    );
    expect(graph.files).toEqual({});
  });
});
