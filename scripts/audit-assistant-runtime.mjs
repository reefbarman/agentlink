#!/usr/bin/env node

import * as esbuild from "esbuild";
import * as path from "node:path";

import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const entrySource = `
import { AgentEngine } from "./src/agent/AgentEngine.js";
import { AgentSessionManager } from "./src/agent/AgentSessionManager.js";

// Keep the imports live so esbuild audits the runtime dependency graph that a
// helper-hosted assistant runtime would need to load.
console.log(AgentEngine, AgentSessionManager);
`;

function normalizeInputPath(inputPath) {
  if (inputPath === "assistant-runtime-audit-entry.ts") return inputPath;
  return path.relative(repoRoot, path.resolve(repoRoot, inputPath));
}

function buildImportGraph(inputs) {
  const graph = new Map();
  const directVscodeImporters = [];

  for (const [rawInputPath, input] of Object.entries(inputs)) {
    const from = normalizeInputPath(rawInputPath);
    const imports = [];

    for (const importRecord of input.imports ?? []) {
      if (importRecord.path === "vscode") {
        directVscodeImporters.push({
          file: from,
          kind: importRecord.kind,
        });
        continue;
      }

      if (importRecord.external) continue;
      imports.push(normalizeInputPath(importRecord.path));
    }

    graph.set(from, imports);
  }

  return { graph, directVscodeImporters };
}

function findShortestPath(graph, target) {
  const start = "assistant-runtime-audit-entry.ts";
  const queue = [[start]];
  const seen = new Set([start]);

  while (queue.length > 0) {
    const pathSoFar = queue.shift();
    const current = pathSoFar.at(-1);
    if (current === target) return pathSoFar;

    for (const next of graph.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...pathSoFar, next]);
    }
  }

  return [target];
}

function formatPathChain(chain) {
  return chain.join(" -> ");
}

function printReport(inputs, graph, directVscodeImporters) {
  console.log("Assistant runtime dependency audit");
  console.log("==================================");
  console.log(`Audited inputs: ${Object.keys(inputs).length}`);
  console.log(
    `Direct runtime vscode importers: ${directVscodeImporters.length}`,
  );
  console.log("");

  if (directVscodeImporters.length === 0) {
    console.log(
      "PASS: helper assistant runtime graph has no runtime import of 'vscode'.",
    );
    return;
  }

  console.log("FAIL: helper assistant runtime graph imports 'vscode'.");
  console.log(
    "These imports must be removed from the helper entry graph before the",
  );
  console.log("assistant agent loop can run outside VS Code.");
  console.log("");

  const sorted = [...directVscodeImporters].sort((a, b) =>
    a.file.localeCompare(b.file),
  );

  for (const { file, kind } of sorted) {
    const chain = findShortestPath(graph, file);
    console.log(`- ${file} (${kind})`);
    console.log(`  ${formatPathChain(chain)}`);
  }
}

async function main() {
  const result = await esbuild.build({
    stdin: {
      contents: entrySource,
      sourcefile: "assistant-runtime-audit-entry.ts",
      resolveDir: repoRoot,
      loader: "ts",
    },
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    external: ["vscode"],
    treeShaking: true,
    logLevel: "silent",
  });

  const inputs = result.metafile.inputs;
  const { graph, directVscodeImporters } = buildImportGraph(inputs);
  printReport(inputs, graph, directVscodeImporters);

  if (directVscodeImporters.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Assistant runtime dependency audit failed to run:");
  console.error(
    error instanceof Error ? error.stack || error.message : String(error),
  );
  process.exitCode = 1;
});
