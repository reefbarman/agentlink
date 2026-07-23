import path from "node:path";

const HEAVY_FEATURE_PATTERNS = {
  mcpManagement:
    /(?:^|\/)src\/shared\/(?:ui\/McpManagerPanel|mcpConfigImport|mcpConfigValidation)\.tsx?$/,
  mermaid: /(?:^|\/)node_modules\/(?:@mermaid-js\/[^/]+|mermaid)(?:\/|$)/,
  monaco: /(?:^|\/)node_modules\/monaco-editor(?:\/|$)/,
  vega: /(?:^|\/)node_modules\/(?:vega|vega-[^/]+)(?:\/|$)/,
};

function normalizePath(value, rootDir) {
  const normalized = path.isAbsolute(value)
    ? path.relative(rootDir, value)
    : value;
  return normalized.split(path.sep).join("/");
}

function outputKind(outputPath) {
  const extension = path.extname(outputPath).toLowerCase();
  if (extension === ".js" || extension === ".mjs") return "script";
  if (extension === ".css") return "style";
  return "asset";
}

function resolveOutputImport(outputPath, importedPath, knownOutputs) {
  const normalizedImport = importedPath.split(path.sep).join("/");
  if (knownOutputs.has(normalizedImport)) return normalizedImport;
  const relative = path.posix.normalize(
    path.posix.join(path.posix.dirname(outputPath), normalizedImport),
  );
  return knownOutputs.has(relative) ? relative : null;
}

function collectInitialScriptOutputs(outputs, entryPoint) {
  const entryOutput = outputs.find(
    (output) => output.kind === "script" && output.entryPoint === entryPoint,
  );
  if (!entryOutput) return [];
  const outputByPath = new Map(outputs.map((output) => [output.path, output]));
  const initial = new Set([entryOutput.path]);
  const pending = [entryOutput.path];
  while (pending.length > 0) {
    const outputPath = pending.pop();
    const output = outputPath ? outputByPath.get(outputPath) : undefined;
    if (!output) continue;
    for (const imported of output.imports) {
      if (imported.external || imported.kind === "dynamic-import") continue;
      const importedOutput = resolveOutputImport(
        output.path,
        imported.path,
        outputByPath,
      );
      if (!importedOutput || initial.has(importedOutput)) continue;
      initial.add(importedOutput);
      pending.push(importedOutput);
    }
  }
  return outputs.filter((output) => initial.has(output.path));
}

export function createBrowserGatewayBundleReport(
  metafile,
  {
    entryPoint = "src/browser-gateway/webview/index.tsx",
    rootDir = process.cwd(),
    topInputLimit = 30,
  } = {},
) {
  const normalizedEntryPoint = normalizePath(entryPoint, rootDir);
  const outputs = Object.entries(metafile.outputs)
    .map(([outputPath, output]) => ({
      path: normalizePath(outputPath, rootDir),
      bytes: output.bytes,
      kind: outputKind(outputPath),
      entryPoint: output.entryPoint
        ? normalizePath(output.entryPoint, rootDir)
        : null,
      imports: output.imports ?? [],
      inputs: output.inputs,
    }))
    .filter((output) => !output.path.endsWith(".map"))
    .sort((left, right) => left.path.localeCompare(right.path));

  const sourceBytes = new Map(
    Object.entries(metafile.inputs).map(([inputPath, input]) => [
      normalizePath(inputPath, rootDir),
      input.bytes,
    ]),
  );
  const inputBytes = new Map();
  for (const output of outputs) {
    for (const [inputPath, contribution] of Object.entries(output.inputs)) {
      const normalizedInput = normalizePath(inputPath, rootDir);
      inputBytes.set(
        normalizedInput,
        (inputBytes.get(normalizedInput) ?? 0) + contribution.bytesInOutput,
      );
    }
  }

  const initialScriptOutputs = collectInitialScriptOutputs(
    outputs,
    normalizedEntryPoint,
  );
  const initialInputBytes = new Map();
  for (const output of initialScriptOutputs) {
    for (const [inputPath, contribution] of Object.entries(output.inputs)) {
      const normalizedInput = normalizePath(inputPath, rootDir);
      initialInputBytes.set(
        normalizedInput,
        (initialInputBytes.get(normalizedInput) ?? 0) +
          contribution.bytesInOutput,
      );
    }
  }

  const inputs = [...inputBytes.entries()]
    .map(([inputPath, bytesInOutput]) => ({
      path: inputPath,
      bytesInOutput,
      sourceBytes: sourceBytes.get(inputPath),
    }))
    .sort(
      (left, right) =>
        right.bytesInOutput - left.bytesInOutput ||
        left.path.localeCompare(right.path),
    );

  const heavyFeatures = Object.fromEntries(
    Object.entries(HEAVY_FEATURE_PATTERNS).map(([name, pattern]) => [
      name,
      inputs
        .filter((input) => pattern.test(input.path))
        .reduce((total, input) => total + input.bytesInOutput, 0),
    ]),
  );
  const initialHeavyFeatures = Object.fromEntries(
    Object.entries(HEAVY_FEATURE_PATTERNS).map(([name, pattern]) => [
      name,
      [...initialInputBytes.entries()]
        .filter(([inputPath]) => pattern.test(inputPath))
        .reduce((total, [, bytesInOutput]) => total + bytesInOutput, 0),
    ]),
  );

  const scriptBytes = outputs
    .filter((output) => output.kind === "script")
    .reduce((total, output) => total + output.bytes, 0);

  return {
    schemaVersion: 2,
    entryPoint: normalizedEntryPoint,
    totalBytes: outputs.reduce((total, output) => total + output.bytes, 0),
    initialScriptBytes: initialScriptOutputs.reduce(
      (total, output) => total + output.bytes,
      0,
    ),
    lazyScriptBytes:
      scriptBytes -
      initialScriptOutputs.reduce((total, output) => total + output.bytes, 0),
    initialScriptOutputs: initialScriptOutputs.map((output) => output.path),
    outputs: outputs.map(
      ({ imports: _imports, inputs: _inputs, ...output }) => output,
    ),
    heavyFeatures,
    initialHeavyFeatures,
    topInputs: inputs.slice(0, topInputLimit),
  };
}

export function verifyBrowserGatewayBundlePackaging(report, vscodeIgnore) {
  const rules = new Set(
    vscodeIgnore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("!")),
  );
  const requiredExactOutputs = [
    "dist/browser-gateway.js",
    "dist/browser-gateway.css",
    "dist/browser-gateway-monaco.js",
    "dist/browser-gateway-monaco.css",
  ];
  for (const output of requiredExactOutputs) {
    if (!report.outputs.some((candidate) => candidate.path === output)) {
      throw new Error(`browser_gateway_runtime_output_missing:${output}`);
    }
    if (!rules.has(`!${output}`)) {
      throw new Error(`browser_gateway_package_allowlist_missing:${output}`);
    }
  }

  const chunkOutputs = report.outputs.filter((output) =>
    output.path.startsWith("dist/browser-gateway-chunks/"),
  );
  const unexpectedChunk = chunkOutputs.find(
    (output) => output.kind !== "script" || !output.path.endsWith(".js"),
  );
  if (unexpectedChunk) {
    throw new Error(
      `browser_gateway_unexpected_lazy_asset:${unexpectedChunk.path}`,
    );
  }
  if (
    chunkOutputs.length > 0 &&
    (!rules.has("!dist/browser-gateway-chunks/") ||
      !rules.has("!dist/browser-gateway-chunks/*.js"))
  ) {
    throw new Error("browser_gateway_chunk_package_allowlist_missing");
  }

  for (const [feature, bytes] of Object.entries(report.initialHeavyFeatures)) {
    if (bytes !== 0) {
      throw new Error(
        `browser_gateway_initial_heavy_feature:${feature}:${bytes}`,
      );
    }
  }
}
