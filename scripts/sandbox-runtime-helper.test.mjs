import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  bindProxyCredentialsToRuntimeDescriptor,
  buildSandboxEnvironment,
  describeLaunch,
  isSandboxRuntimeDescriptor,
  parseSandboxRuntimeRequest,
} from "./sandbox-runtime-helper.mjs";

import { ProtectedRootLeaseCoordinator } from "./sandbox-protected-roots.mjs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = path.join(SCRIPT_DIR, "sandbox-runtime-helper.mjs");
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const darwinTest = process.platform === "darwin" ? test : test.skip;

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function makeRequest(root, overrides = {}) {
  const privateHome = path.join(root, "home");
  const privateTmp = path.join(root, "tmp");
  return {
    version: 2,
    operation: "execute",
    command: "/usr/bin/true",
    cwd: root,
    shell: "/bin/bash",
    environment: {
      HOME: privateHome,
      TMPDIR: privateTmp,
      XDG_CACHE_HOME: path.join(root, "cache"),
    },
    filesystem: {
      denyRead: [homedir()],
      allowRead: [root],
      allowWrite: [root],
      denyWrite: [],
    },
    network: { allowedDomains: [] },
    protectedRoots: [],
    structurallyProtectedRoots: [],
    timeoutMs: 10_000,
    ...overrides,
  };
}

async function runHelper(request, environment = process.env) {
  const child = spawn(process.execPath, [HELPER_PATH], {
    cwd: REPO_ROOT,
    env: environment,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(JSON.stringify(request));
  const { exitCode, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  const text = Buffer.concat(stdout).toString("utf8").trim();
  return {
    exitCode,
    signal,
    stderr: Buffer.concat(stderr).toString("utf8"),
    response: JSON.parse(text),
  };
}

async function makeSandboxRoot(prefix) {
  const fixtureRoot = path.join(REPO_ROOT, "tmp");
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(path.join(fixtureRoot, `al-srt-${prefix}-`));
  await Promise.all([
    mkdir(path.join(root, "home"), { recursive: true }),
    mkdir(path.join(root, "tmp"), { recursive: true }),
    mkdir(path.join(root, "cache"), { recursive: true }),
  ]);
  return root;
}

async function waitForPath(target, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(target);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${target}`);
}

function protectedFilesystem(root, deniedPaths) {
  return {
    denyRead: [homedir()],
    allowRead: [root],
    allowWrite: [root],
    denyWrite: deniedPaths,
  };
}

test("validates the one-request protocol and rejects authority-like extras", () => {
  const root = "/private/tmp/al-srt-fixture";
  const request = makeRequest(root);
  assert.deepEqual(parseSandboxRuntimeRequest(request), request);
  assert.throws(
    () => parseSandboxRuntimeRequest({ ...request, grantToken: "untrusted" }),
    /unsupported field: grantToken/,
  );
  assert.throws(
    () =>
      parseSandboxRuntimeRequest({
        ...request,
        environment: { DYLD_INSERT_LIBRARIES: "/tmp/escape.dylib" },
      }),
    /reserved by the sandbox helper/,
  );
  assert.throws(
    () =>
      parseSandboxRuntimeRequest({
        ...request,
        network: { allowedDomains: ["https://example.com/path"] },
      }),
    /not a bare domain pattern/,
  );
  assert.throws(
    () => parseSandboxRuntimeRequest({ ...request, environment: {} }),
    /environment.HOME must be a non-empty string/,
  );
  assert.throws(
    () =>
      parseSandboxRuntimeRequest({
        ...request,
        environment: {
          ...request.environment,
          HOME: "/private/outside-policy",
        },
      }),
    /environment.HOME must be within filesystem.allowRead/,
  );
  assert.doesNotThrow(() =>
    parseSandboxRuntimeRequest({
      ...request,
      environment: {
        ...request.environment,
        HOME: "/Users/example",
      },
      filesystem: {
        ...request.filesystem,
        denyRead: [],
        allowRead: ["/"],
      },
    }),
  );
  assert.throws(
    () =>
      parseSandboxRuntimeRequest({
        ...request,
        environment: {
          ...request.environment,
          TMPDIR: "/Users/example/tmp",
        },
        filesystem: {
          ...request.filesystem,
          denyRead: [],
          allowRead: ["/"],
        },
      }),
    /environment.TMPDIR must be within filesystem.allowWrite/,
  );
  assert.throws(
    () =>
      parseSandboxRuntimeRequest(
        makeRequest(
          "/private/tmp/this-private-sandbox-root-is-deliberately-too-long-for-the-runtime-mux-socket-path-budget",
        ),
      ),
    /TMPDIR is too long for macOS Unix sockets/,
  );
  assert.throws(() => {
    const { structurallyProtectedRoots: _omitted, ...missingStructuralRoots } =
      request;
    parseSandboxRuntimeRequest(missingStructuralRoots);
  }, /request\.structurallyProtectedRoots must be an array/);
  assert.throws(
    () =>
      parseSandboxRuntimeRequest({
        ...request,
        protectedRoots: [path.join(root, ".agentlink")],
      }),
    /protected root must be covered by filesystem.denyWrite/,
  );
});

test("builds a deterministic environment without inheriting host values", () => {
  const environment = buildSandboxEnvironment({
    HOME: "/private/home",
    TERM: "xterm-256color",
  });
  assert.deepEqual(environment, {
    HOME: "/private/home",
    TERM: "xterm-256color",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
  });
  assert.equal(environment.FOO_TOKEN, undefined);
  assert.equal(environment.SSH_AUTH_SOCK, undefined);
});

test("rejects spoofed or structurally unexpected runtime descriptors", () => {
  const request = {
    shell: "/bin/bash",
    command: "printf /usr/bin/sandbox-exec",
  };
  const validWrapper =
    "env SANDBOX_RUNTIME=1 /usr/bin/sandbox-exec -p 'profile' /bin/bash -c 'printf /usr/bin/sandbox-exec'";
  assert.equal(
    isSandboxRuntimeDescriptor(["/bin/bash", "-c", validWrapper], request),
    true,
  );
  assert.equal(
    isSandboxRuntimeDescriptor(
      ["/bin/bash", "-c", "printf /usr/bin/sandbox-exec"],
      request,
    ),
    false,
  );
  assert.equal(
    isSandboxRuntimeDescriptor(["/bin/zsh", "-c", validWrapper], request),
    false,
  );
  assert.equal(
    isSandboxRuntimeDescriptor(
      ["/bin/bash", "-c", validWrapper, "extra"],
      request,
    ),
    false,
  );
  assert.equal(
    isSandboxRuntimeDescriptor(
      ["/bin/bash", "-c", validWrapper.replace("env ", "env SAFE=1; ")],
      request,
    ),
    false,
  );
  assert.equal(
    isSandboxRuntimeDescriptor(
      [
        "/bin/bash",
        "-c",
        validWrapper.replace(
          "/usr/bin/sandbox-exec -p ",
          "/usr/bin/sandbox-exec -p duplicate /usr/bin/sandbox-exec -p ",
        ),
      ],
      request,
    ),
    false,
  );
});

test("binds generated credentials only to the exact external proxy descriptor contract", () => {
  const request = {
    shell: "/bin/bash",
    command: "/usr/bin/true",
    network: { allowedDomains: ["example.com"] },
  };
  const unauthenticated = [
    "/bin/bash",
    "-c",
    [
      "env",
      ...Array.from(
        { length: 8 },
        (_, index) => `P${index}=http://localhost:41001`,
      ),
      ...Array.from(
        { length: 4 },
        (_, index) => `S${index}=socks5h://localhost:41002`,
      ),
      "/usr/bin/sandbox-exec -p 'profile' /bin/bash -c /usr/bin/true",
    ].join(" "),
  ];
  const networkProxies = {
    httpPort: 41001,
    socksPort: 41002,
    credentials: {
      username: "agentlink",
      password: "a".repeat(64),
    },
  };
  const authenticated = bindProxyCredentialsToRuntimeDescriptor(
    unauthenticated,
    request,
    networkProxies,
  );
  assert.equal(authenticated[0], unauthenticated[0]);
  assert.equal(authenticated[1], unauthenticated[1]);
  assert.equal(authenticated[2].split("http://agentlink:").length - 1, 8);
  assert.equal(authenticated[2].split("socks5h://agentlink:").length - 1, 4);
  assert.equal(authenticated[2].includes("http://localhost:41001"), false);
  assert.equal(authenticated[2].includes("socks5h://localhost:41002"), false);
  const launch = describeLaunch(authenticated, {}, "/workspace");
  assert.equal(
    JSON.stringify(launch).includes(networkProxies.credentials.password),
    false,
  );

  assert.throws(
    () =>
      bindProxyCredentialsToRuntimeDescriptor(
        [
          unauthenticated[0],
          unauthenticated[1],
          unauthenticated[2].replace("P7=http://localhost:41001 ", ""),
        ],
        request,
        networkProxies,
      ),
    /proxy contract drifted for HTTP proxy URLs: expected 8, found 7/,
  );
  assert.throws(
    () =>
      bindProxyCredentialsToRuntimeDescriptor(unauthenticated, request, {
        ...networkProxies,
        credentials: { username: "agentlink", password: "untrusted" },
      }),
    /invalid session credentials/,
  );
  assert.throws(
    () =>
      bindProxyCredentialsToRuntimeDescriptor(
        [
          unauthenticated[0],
          unauthenticated[1],
          unauthenticated[2]
            .replaceAll(
              "http://localhost:41001",
              "http://unexpected:value@localhost:41001",
            )
            .replaceAll(
              "socks5h://localhost:41002",
              "socks5h://unexpected:value@localhost:41002",
            ),
        ],
        request,
        networkProxies,
      ),
    /unexpected proxy credentials or URL syntax/,
  );
});

test("does not inject proxy credentials when networking is disabled", () => {
  const request = {
    shell: "/bin/bash",
    command: "/usr/bin/true",
    network: { allowedDomains: [] },
  };
  const argv = [
    "/bin/bash",
    "-c",
    "env SANDBOX_RUNTIME=1 /usr/bin/sandbox-exec -p 'profile' /bin/bash -c /usr/bin/true",
  ];
  assert.equal(
    bindProxyCredentialsToRuntimeDescriptor(argv, request, {
      httpPort: 1,
      socksPort: 2,
      credentials: { username: "invalid", password: "invalid" },
    }),
    argv,
  );
});

test("redacts the generated wrapper and environment values from launch metadata", () => {
  const launch = describeLaunch(
    [
      "/bin/bash",
      "-c",
      "/usr/bin/sandbox-exec -p secret-profile /usr/bin/true",
    ],
    { API_VALUE: "secret-value" },
    "/workspace",
  );
  assert.equal(launch.executable, "/bin/bash");
  assert.equal(launch.usesSandboxExec, true);
  assert.deepEqual(launch.environmentKeys, ["API_VALUE"]);
  assert.equal(JSON.stringify(launch).includes("secret-profile"), false);
  assert.equal(JSON.stringify(launch).includes("secret-value"), false);
});

darwinTest(
  "allows workspace and private HOME/TMP writes with a sanitized environment",
  async () => {
    const root = await makeSandboxRoot("allowed");
    try {
      const workspaceFile = path.join(root, "workspace.txt");
      const homeFile = path.join(root, "home", "home.txt");
      const tmpFile = path.join(root, "tmp", "tmp.txt");
      const command = [
        `printf workspace > ${shellQuote(workspaceFile)}`,
        `printf home > ${shellQuote(homeFile)}`,
        `printf tmp > ${shellQuote(tmpFile)}`,
        `test -z "$FOO_TOKEN"`,
        `test "$HOME" = ${shellQuote(path.join(root, "home"))}`,
        `test "$TMPDIR" = ${shellQuote(path.join(root, "tmp"))}`,
      ].join(" && ");
      const outcome = await runHelper(makeRequest(root, { command }), {
        ...process.env,
        FOO_TOKEN: "must-not-cross-helper-boundary",
      });
      assert.equal(outcome.exitCode, 0, outcome.stderr);
      assert.equal(outcome.response.ok, true, JSON.stringify(outcome.response));
      assert.equal(outcome.response.cleanupComplete, true);
      assert.equal(
        outcome.response.result.exitCode,
        0,
        outcome.response.result.stderr,
      );
      assert.equal(await readFile(workspaceFile, "utf8"), "workspace");
      assert.equal(await readFile(homeFile, "utf8"), "home");
      assert.equal(await readFile(tmpFile, "utf8"), "tmp");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

darwinTest(
  "denies reads from the real home outside the allowed workspace",
  async (t) => {
    const candidates = [
      path.join(homedir(), ".ssh"),
      path.join(homedir(), ".gitconfig"),
      path.join(homedir(), "Library", "Keychains"),
    ];
    let deniedTarget;
    for (const candidate of candidates) {
      try {
        await access(candidate);
        deniedTarget = candidate;
        break;
      } catch {}
    }
    if (!deniedTarget) {
      t.skip("no existing real-home credential target is available");
      return;
    }

    const root = await makeSandboxRoot("home-deny");
    try {
      const outcome = await runHelper(
        makeRequest(root, { command: `test -r ${shellQuote(deniedTarget)}` }),
      );
      assert.equal(outcome.response.ok, true, JSON.stringify(outcome.response));
      assert.notEqual(outcome.response.result.exitCode, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

darwinTest("blocks network when the domain allowlist is empty", async () => {
  const root = await makeSandboxRoot("network-deny");
  try {
    const outcome = await runHelper(
      makeRequest(root, {
        command:
          "/usr/bin/curl --fail --silent --show-error --connect-timeout 2 http://example.com >/dev/null",
      }),
    );
    assert.equal(outcome.response.ok, true, JSON.stringify(outcome.response));
    assert.notEqual(outcome.response.result.exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

darwinTest(
  "terminates background descendants when the shell exits",
  async () => {
    const root = await makeSandboxRoot("descendants");
    try {
      const startedAt = Date.now();
      const outcome = await runHelper(
        makeRequest(root, { command: "/bin/sleep 30 &" }),
      );
      assert.equal(outcome.response.ok, true, JSON.stringify(outcome.response));
      assert.equal(
        outcome.response.result.exitCode,
        0,
        outcome.response.result.stderr,
      );
      assert.equal(outcome.response.cleanupComplete, true);
      assert.ok(
        Date.now() - startedAt < 5_000,
        "background descendant was not terminated",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

darwinTest(
  "protects .git and AgentLink policy descendants from create, truncate, unlink, and rename",
  async () => {
    const root = await makeSandboxRoot("protected");
    const gitRoot = path.join(root, ".git");
    const policyRoot = path.join(root, ".agentlink");
    const gitConfig = path.join(gitRoot, "config");
    const gitHook = path.join(gitRoot, "hooks", "pre-commit");
    const policyFile = path.join(policyRoot, "policy.json");
    const historyFile = path.join(policyRoot, "history", "sessions.json");
    const normalFile = path.join(root, "normal.txt");
    const renameSource = path.join(root, "rename-source.txt");
    try {
      await Promise.all([
        mkdir(path.dirname(gitHook), { recursive: true }),
        mkdir(path.dirname(historyFile), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(gitConfig, "git-config-original"),
        writeFile(gitHook, "git-hook-original"),
        writeFile(policyFile, "policy-original"),
        writeFile(historyFile, "history-original"),
        writeFile(renameSource, "rename-source"),
      ]);
      const command = [
        `printf allowed > ${shellQuote(normalFile)}`,
        `! printf attacked > ${shellQuote(gitConfig)}`,
        `! printf attacked > ${shellQuote(gitHook)}`,
        `! printf attacked > ${shellQuote(policyFile)}`,
        `! printf attacked > ${shellQuote(historyFile)}`,
        `! rm ${shellQuote(gitConfig)}`,
        `! mv ${shellQuote(renameSource)} ${shellQuote(path.join(gitRoot, "renamed.txt"))}`,
        `! mkdir ${shellQuote(path.join(policyRoot, "nested"))}`,
      ].join(" && ");
      const outcome = await runHelper(
        makeRequest(root, {
          command,
          filesystem: protectedFilesystem(root, [gitRoot, policyRoot]),
          protectedRoots: [gitRoot, policyFile],
        }),
      );
      assert.equal(outcome.response.ok, true, JSON.stringify(outcome.response));
      assert.equal(
        outcome.response.result.exitCode,
        0,
        outcome.response.result.stderr,
      );
      assert.equal(await readFile(normalFile, "utf8"), "allowed");
      assert.equal(await readFile(gitConfig, "utf8"), "git-config-original");
      assert.equal(await readFile(gitHook, "utf8"), "git-hook-original");
      assert.equal(await readFile(policyFile, "utf8"), "policy-original");
      assert.equal(await readFile(historyFile, "utf8"), "history-original");
      assert.equal(await readFile(renameSource, "utf8"), "rename-source");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

darwinTest(
  "blocks existing symlink aliases into protected descendants",
  async () => {
    const root = await makeSandboxRoot("symlink");
    const protectedRoot = path.join(root, ".agentlink");
    const protectedFile = path.join(protectedRoot, "policy.json");
    const alias = path.join(root, "policy-alias.json");
    try {
      await mkdir(protectedRoot, { recursive: true });
      await writeFile(protectedFile, "policy-original");
      await symlink(protectedFile, alias);
      const outcome = await runHelper(
        makeRequest(root, {
          command: `printf attacked > ${shellQuote(alias)}`,
          filesystem: protectedFilesystem(root, [protectedRoot]),
          protectedRoots: [protectedRoot],
        }),
      );
      assert.equal(outcome.response.ok, true, JSON.stringify(outcome.response));
      assert.notEqual(outcome.response.result.exitCode, 0);
      assert.equal(await readFile(protectedFile, "utf8"), "policy-original");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

darwinTest(
  "blocks creation at protected paths that do not exist at wrap time",
  async () => {
    const root = await makeSandboxRoot("nonexistent");
    const futureFile = path.join(root, ".agentlink", "future-policy.json");
    const futureDirectory = path.join(root, ".git", "future-hooks");
    try {
      await Promise.all([
        mkdir(path.dirname(futureFile), { recursive: true }),
        mkdir(path.dirname(futureDirectory), { recursive: true }),
      ]);
      const command = [
        `! printf attacked > ${shellQuote(futureFile)}`,
        `! mkdir -p ${shellQuote(futureDirectory)}`,
      ].join(" && ");
      const outcome = await runHelper(
        makeRequest(root, {
          command,
          filesystem: protectedFilesystem(root, [
            path.dirname(futureFile),
            path.dirname(futureDirectory),
          ]),
          protectedRoots: [
            path.dirname(futureFile),
            path.dirname(futureDirectory),
          ],
        }),
      );
      assert.equal(outcome.response.ok, true, JSON.stringify(outcome.response));
      assert.equal(
        outcome.response.result.exitCode,
        0,
        outcome.response.result.stderr,
      );
      await assert.rejects(access(futureFile));
      await assert.rejects(access(futureDirectory));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

darwinTest(
  "fails closed before launch on pre-existing hard-link aliases",
  async () => {
    const root = await makeSandboxRoot("hardlink");
    const protectedRoot = path.join(root, ".agentlink");
    const protectedFile = path.join(protectedRoot, "policy.json");
    const alias = path.join(root, "policy-hardlink.json");
    try {
      await mkdir(protectedRoot, { recursive: true });
      await writeFile(protectedFile, "policy-original");
      await link(protectedFile, alias);
      const outcome = await runHelper(
        makeRequest(root, {
          command: `printf hardlink-bypass > ${shellQuote(alias)}`,
          filesystem: protectedFilesystem(root, [protectedRoot]),
          protectedRoots: [protectedRoot],
        }),
      );
      assert.equal(outcome.exitCode, 1);
      assert.equal(outcome.response.ok, false);
      assert.match(outcome.response.error, /unexpected hard-link count 2/);
      assert.equal(await readFile(protectedFile, "utf8"), "policy-original");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

darwinTest(
  "blocks creating a new hard-link alias to a protected file",
  async () => {
    const root = await makeSandboxRoot("hardlink-create");
    const protectedRoot = path.join(root, ".agentlink");
    const protectedFile = path.join(protectedRoot, "policy.json");
    const alias = path.join(root, "created-hardlink.json");
    try {
      await mkdir(protectedRoot, { recursive: true });
      await writeFile(protectedFile, "policy-original");
      const outcome = await runHelper(
        makeRequest(root, {
          command: `ln ${shellQuote(protectedFile)} ${shellQuote(alias)}`,
          filesystem: protectedFilesystem(root, [protectedRoot]),
          protectedRoots: [protectedRoot],
        }),
      );
      assert.equal(outcome.response.ok, true, JSON.stringify(outcome.response));
      assert.notEqual(outcome.response.result.exitCode, 0);
      await assert.rejects(access(alias));
      assert.equal(await readFile(protectedFile, "utf8"), "policy-original");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

darwinTest("blocks the sandbox from renaming a protected root", async () => {
  const root = await makeSandboxRoot("self-rename");
  const protectedRoot = path.join(root, ".agentlink");
  const movedRoot = path.join(root, "moved-policy");
  const protectedFile = path.join(protectedRoot, "policy.json");
  try {
    await mkdir(protectedRoot, { recursive: true });
    await writeFile(protectedFile, "policy-original");
    const outcome = await runHelper(
      makeRequest(root, {
        command: `mv ${shellQuote(protectedRoot)} ${shellQuote(movedRoot)}`,
        filesystem: protectedFilesystem(root, [protectedRoot]),
        protectedRoots: [protectedRoot],
      }),
    );
    assert.equal(outcome.response.ok, true, JSON.stringify(outcome.response));
    assert.notEqual(outcome.response.result.exitCode, 0);
    assert.equal(await readFile(protectedFile, "utf8"), "policy-original");
    await assert.rejects(access(movedRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

darwinTest(
  "coordinates trusted-host protected-root mutations for the command lifetime",
  async () => {
    const root = await makeSandboxRoot("rename-race");
    const protectedRoot = path.join(root, ".agentlink");
    const movedRoot = path.join(root, "moved-policy");
    const protectedFile = path.join(protectedRoot, "policy.json");
    const launched = path.join(root, "launched");
    const proceed = path.join(root, "proceed");
    try {
      await mkdir(protectedRoot, { recursive: true });
      await writeFile(protectedFile, "policy-original");
      const command = [
        `: > ${shellQuote(launched)}`,
        `while [ ! -e ${shellQuote(proceed)} ]; do sleep 0.01; done`,
        `printf attacked > ${shellQuote(protectedFile)}`,
      ].join(" && ");
      const coordinator = new ProtectedRootLeaseCoordinator();
      const outcome = await coordinator.withLease([protectedRoot], async () => {
        const helper = runHelper(
          makeRequest(root, {
            command,
            filesystem: protectedFilesystem(root, [protectedRoot]),
            protectedRoots: [protectedRoot],
          }),
        );
        await waitForPath(launched);
        await assert.rejects(
          coordinator.runMutation([protectedRoot, movedRoot], () =>
            rename(protectedRoot, movedRoot),
          ),
          /overlaps an active protected root lease/,
        );
        await writeFile(proceed, "go");
        return helper;
      });
      assert.equal(outcome.response.ok, true, JSON.stringify(outcome.response));
      assert.notEqual(outcome.response.result.exitCode, 0);
      assert.equal(await readFile(protectedFile, "utf8"), "policy-original");
      await assert.rejects(access(movedRoot));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

darwinTest(
  "blocks a symlink swapped to a protected descendant after launch",
  async () => {
    const root = await makeSandboxRoot("path-race");
    const protectedRoot = path.join(root, ".agentlink");
    const safeRoot = path.join(root, "safe");
    const protectedFile = path.join(protectedRoot, "policy.json");
    const alias = path.join(root, "active-target");
    const launched = path.join(root, "launched");
    const proceed = path.join(root, "proceed");
    try {
      await Promise.all([
        mkdir(protectedRoot, { recursive: true }),
        mkdir(safeRoot, { recursive: true }),
      ]);
      await writeFile(protectedFile, "policy-original");
      await symlink(safeRoot, alias);
      const command = [
        `: > ${shellQuote(launched)}`,
        `while [ ! -e ${shellQuote(proceed)} ]; do sleep 0.01; done`,
        `printf attacked > ${shellQuote(path.join(alias, "policy.json"))}`,
      ].join(" && ");
      const helper = runHelper(
        makeRequest(root, {
          command,
          filesystem: protectedFilesystem(root, [protectedRoot]),
          protectedRoots: [protectedRoot],
        }),
      );
      await waitForPath(launched);
      await unlink(alias);
      await symlink(protectedRoot, alias);
      await writeFile(proceed, "go");
      const outcome = await helper;
      assert.equal(outcome.response.ok, true, JSON.stringify(outcome.response));
      assert.notEqual(outcome.response.result.exitCode, 0);
      assert.equal(await readFile(protectedFile, "utf8"), "policy-original");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

darwinTest(
  "isolates concurrent helpers with different filesystem policies",
  async () => {
    const rootA = await makeSandboxRoot("concurrent-a");
    const rootB = await makeSandboxRoot("concurrent-b");
    try {
      const secretA = path.join(rootA, "secret.txt");
      const secretB = path.join(rootB, "secret.txt");
      await Promise.all([writeFile(secretA, "a"), writeFile(secretB, "b")]);
      const requestA = makeRequest(rootA, {
        filesystem: {
          denyRead: [homedir(), rootB],
          allowRead: [rootA],
          allowWrite: [rootA],
          denyWrite: [],
        },
        command: `cat ${shellQuote(secretA)} && ! cat ${shellQuote(secretB)} >/dev/null 2>&1`,
      });
      const requestB = makeRequest(rootB, {
        filesystem: {
          denyRead: [homedir(), rootA],
          allowRead: [rootB],
          allowWrite: [rootB],
          denyWrite: [],
        },
        command: `cat ${shellQuote(secretB)} && ! cat ${shellQuote(secretA)} >/dev/null 2>&1`,
      });

      const [outcomeA, outcomeB] = await Promise.all([
        runHelper(requestA),
        runHelper(requestB),
      ]);
      assert.equal(
        outcomeA.response.ok,
        true,
        JSON.stringify(outcomeA.response),
      );
      assert.equal(
        outcomeB.response.ok,
        true,
        JSON.stringify(outcomeB.response),
      );
      assert.equal(
        outcomeA.response.result.exitCode,
        0,
        outcomeA.response.result.stderr,
      );
      assert.equal(
        outcomeB.response.result.exitCode,
        0,
        outcomeB.response.result.stderr,
      );
      assert.equal(outcomeA.response.result.stdout, "a");
      assert.equal(outcomeB.response.result.stdout, "b");
      assert.equal(outcomeA.response.cleanupComplete, true);
      assert.equal(outcomeB.response.cleanupComplete, true);
    } finally {
      await Promise.all([
        rm(rootA, { recursive: true, force: true }),
        rm(rootB, { recursive: true, force: true }),
      ]);
    }
  },
);
