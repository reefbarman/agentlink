import {
  LINUX_BWRAP_PATH,
  LinuxSandboxUnavailableError,
  bindLinuxProxyCredentials,
  isLinuxSandboxRuntimeDescriptor,
  linuxApplySeccompPath,
  linuxSandboxRuntimeConfig,
  resolveLinuxSandboxTools,
} from "./sandbox-linux-runtime.mjs";

import assert from "node:assert/strict";
import test from "node:test";

const runtimeRoot = "/ext/dist/sandbox-runtime";
const tools = Object.freeze({
  bwrapPath: LINUX_BWRAP_PATH,
  socatPath: "/usr/bin/socat",
  ripgrepPath: "/usr/bin/rg",
  applySeccompPath: linuxApplySeccompPath(runtimeRoot, "x64"),
});
const request = { shell: "/bin/bash", command: "echo hi" };
const credentials = { username: "agentlink", password: "a".repeat(64) };

const HTTP_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "GRPC_PROXY",
  "grpc_proxy",
  "DOCKER_HTTP_PROXY",
  "DOCKER_HTTPS_PROXY",
];

/** A wrapper shaped like SRT 0.0.79's Linux output (see the spike notes). */
function wrapper({
  bwrapArgs = [
    "--new-session",
    "--die-with-parent",
    "--unshare-net",
    ...HTTP_KEYS.flatMap((key) => ["--setenv", key, "http://localhost:3128"]),
    "--setenv FTP_PROXY socks5h://localhost:1080",
    "--setenv ftp_proxy socks5h://localhost:1080",
    "--setenv RSYNC_PROXY localhost:1080",
    "--ro-bind / /",
    "--bind /work /work",
    "--dev /dev",
    "--unshare-pid",
    "--unshare-user",
    "--cap-drop ALL",
    "--proc /proc",
  ],
  inner = `/usr/bin/socat TCP-LISTEN:3128,fork UNIX-CONNECT:/tmp/claude-http.sock &\n${tools.applySeccompPath} /bin/bash -c 'echo hi'`,
} = {}) {
  return [
    request.shell,
    "-c",
    `${LINUX_BWRAP_PATH} ${bwrapArgs.join(" ")} -- /bin/bash -c '${inner}'`,
  ];
}

test("resolves fixed tool paths and the staged apply-seccomp", () => {
  const present = new Set([
    LINUX_BWRAP_PATH,
    "/bin/socat",
    "/usr/bin/rg",
    linuxApplySeccompPath(runtimeRoot, "arm64"),
  ]);
  const resolved = resolveLinuxSandboxTools({
    runtimeRoot,
    architecture: "arm64",
    environment: {},
    isExecutableFile: (filePath) => present.has(filePath),
  });
  assert.deepEqual(resolved, {
    bwrapPath: LINUX_BWRAP_PATH,
    socatPath: "/bin/socat",
    ripgrepPath: "/usr/bin/rg",
    applySeccompPath: `${runtimeRoot}/vendor/seccomp/arm64/apply-seccomp`,
  });
  assert.deepEqual(linuxSandboxRuntimeConfig(resolved), {
    bwrapPath: LINUX_BWRAP_PATH,
    socatPath: "/bin/socat",
    ripgrep: { command: "/usr/bin/rg" },
    seccomp: { applyPath: `${runtimeRoot}/vendor/seccomp/arm64/apply-seccomp` },
    enableWeakerNestedSandbox: false,
  });
});

test("prefers a host ripgrep and never looks tools up on PATH", () => {
  const hostRipgrep = "/opt/vscode/resources/app/node_modules/rg";
  const seen = [];
  const resolved = resolveLinuxSandboxTools({
    runtimeRoot,
    architecture: "x64",
    environment: { AGENTLINK_SANDBOX_RIPGREP_PATH: hostRipgrep, PATH: "/evil" },
    isExecutableFile: (filePath) => {
      seen.push(filePath);
      return true;
    },
  });
  assert.equal(resolved.ripgrepPath, hostRipgrep);
  assert.equal(
    seen.some((filePath) => filePath.startsWith("/evil")),
    false,
  );
});

test("refuses when any tool, including apply-seccomp, is missing", () => {
  assert.throws(
    () =>
      resolveLinuxSandboxTools({
        runtimeRoot,
        architecture: "x64",
        environment: {},
        isExecutableFile: (filePath) => filePath === LINUX_BWRAP_PATH,
      }),
    (error) =>
      error instanceof LinuxSandboxUnavailableError &&
      error.missing.length === 3 &&
      /socat/.test(error.message) &&
      /ripgrep/.test(error.message) &&
      /apply-seccomp/.test(error.message),
  );
  assert.throws(
    () =>
      resolveLinuxSandboxTools({
        runtimeRoot,
        architecture: "ia32",
        isExecutableFile: () => true,
      }),
    /architecture ia32/,
  );
  assert.throws(
    () =>
      resolveLinuxSandboxTools({
        runtimeRoot: "/home/me/my extensions/runtime",
        architecture: "x64",
        environment: {},
        isExecutableFile: () => true,
      }),
    /needs shell quoting/,
  );
});

test("accepts the reviewed bubblewrap launch", () => {
  assert.equal(
    isLinuxSandboxRuntimeDescriptor(wrapper(), request, tools, { euid: 1000 }),
    true,
  );
});

test("rejects launches missing confinement or with extra authority", () => {
  const base = wrapper()[2];
  const cases = {
    "no network namespace": base.replace(" --unshare-net", ""),
    "no user namespace": base.replace(" --unshare-user", ""),
    "no pid namespace": base.replace(" --unshare-pid", ""),
    "capabilities kept": base.replace(" --cap-drop ALL", ""),
    "writable root": base.replace("--ro-bind / /", "--bind / /"),
    "shared network": base.replace(
      "--unshare-net",
      "--unshare-net --share-net",
    ),
    "added capability": base.replace(
      "--cap-drop ALL",
      "--cap-drop ALL --cap-add CAP_SYS_ADMIN",
    ),
    "args file": base.replace("--dev /dev", "--args 3"),
    "no seccomp": base.replace(`${tools.applySeccompPath} `, ""),
    "seccomp twice": base.replace(
      "echo hi",
      `echo hi; ${tools.applySeccompPath} /bin/bash -c x`,
    ),
    "other bwrap": base.replace(LINUX_BWRAP_PATH, "/tmp/bwrap"),
  };
  for (const [label, candidate] of Object.entries(cases)) {
    assert.equal(
      isLinuxSandboxRuntimeDescriptor(
        [request.shell, "-c", candidate],
        request,
        tools,
        { euid: 1000 },
      ),
      false,
      label,
    );
  }
  assert.equal(
    isLinuxSandboxRuntimeDescriptor(["/bin/sh", "-c", base], request, tools, {
      euid: 1000,
    }),
    false,
    "different shell",
  );
  assert.equal(
    isLinuxSandboxRuntimeDescriptor(
      [request.shell, "-c", `${base}${"x".repeat(128 * 1024)}`],
      request,
      tools,
      { euid: 1000 },
    ),
    false,
    "over the per-argument limit",
  );
});

test("allows CAP_SETFCAP only for a root caller", () => {
  const setfcap = wrapper()[2].replace(
    "--cap-drop ALL",
    "--cap-drop ALL --cap-add CAP_SETFCAP",
  );
  const argv = [request.shell, "-c", setfcap];
  assert.equal(
    isLinuxSandboxRuntimeDescriptor(argv, request, tools, { euid: 0 }),
    true,
  );
  assert.equal(
    isLinuxSandboxRuntimeDescriptor(argv, request, tools, { euid: 1000 }),
    false,
  );
});

test("binds session credentials to every in-sandbox proxy URL", () => {
  const authenticated = bindLinuxProxyCredentials(
    wrapper(),
    request,
    tools,
    { credentials },
    { euid: 1000 },
  );
  const text = authenticated[2];
  assert.equal(
    text.split(`http://agentlink:${"a".repeat(64)}@localhost:3128`).length - 1,
    10,
  );
  assert.equal(
    text.split(`socks5h://agentlink:${"a".repeat(64)}@localhost:1080`).length -
      1,
    2,
  );
  assert.equal(text.includes("http://localhost:3128"), false);
});

test("fails closed when the proxy contract drifts", () => {
  const drifted = wrapper()[2].replace(
    "--setenv grpc_proxy http://localhost:3128",
    "",
  );
  assert.throws(
    () =>
      bindLinuxProxyCredentials(
        [request.shell, "-c", drifted],
        request,
        tools,
        { credentials },
        { euid: 1000 },
      ),
    /expected 10, found 9/,
  );
  assert.throws(
    () =>
      bindLinuxProxyCredentials(
        wrapper(),
        request,
        tools,
        { credentials: { username: "agentlink", password: "short" } },
        { euid: 1000 },
      ),
    /invalid session credentials/,
  );
});

test("passes a proxy-free launch through unchanged", () => {
  const argv = wrapper({
    bwrapArgs: [
      "--new-session",
      "--die-with-parent",
      "--unshare-net",
      "--ro-bind / /",
      "--unshare-pid",
      "--unshare-user",
      "--cap-drop ALL",
    ],
  });
  assert.equal(
    bindLinuxProxyCredentials(
      argv,
      request,
      tools,
      { credentials },
      {
        euid: 1000,
      },
    ),
    argv,
  );
});
