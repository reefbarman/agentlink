// Linux (bubblewrap) support for the sandbox helpers.
//
// The sandbox runtime wraps each command as `<shell> -c '<bwrap ...> -- ...'`.
// On Linux it also needs socat (to bridge the proxy into the sandbox's network
// namespace), ripgrep (to expand deny paths) and apply-seccomp (to stop the
// command creating unix sockets). Every tool path is fixed or host-provided:
// nothing is looked up on PATH, and a missing tool refuses the launch.

import { accessSync, constants, lstatSync } from "node:fs";

import path from "node:path";

export const LINUX_BWRAP_PATH = "/usr/bin/bwrap";
export const LINUX_SOCAT_CANDIDATES = Object.freeze([
  "/usr/bin/socat",
  "/bin/socat",
]);
export const LINUX_RIPGREP_CANDIDATES = Object.freeze(["/usr/bin/rg"]);
/** Host-provided ripgrep, for example VS Code's bundled `rg`. */
export const LINUX_RIPGREP_ENVIRONMENT_KEY = "AGENTLINK_SANDBOX_RIPGREP_PATH";

/** The per-argument limit (MAX_ARG_STRLEN) the wrapper must fit in. */
export const LINUX_MAX_ARGUMENT_BYTES = 128 * 1024;
/** A conservative ARG_MAX for the whole argv and environment. */
export const LINUX_EXEC_SIZE_LIMIT_BYTES = 2 * 1024 * 1024;

// Proxies are bridged to fixed ports inside the sandbox's network namespace.
const LINUX_HTTP_PROXY_URL = "http://localhost:3128";
const LINUX_SOCKS_PROXY_URL = "socks5h://localhost:1080";
// SRT 0.0.79 sets HTTP(S)_PROXY, ALL_PROXY, GRPC_PROXY (and lowercase), plus
// DOCKER_HTTP(S)_PROXY to the HTTP URL, and FTP_PROXY/ftp_proxy to SOCKS.
const LINUX_HTTP_PROXY_URL_COUNT = 10;
const LINUX_SOCKS_PROXY_URL_COUNT = 2;

const SIMPLE_PATH = /^\/[A-Za-z0-9_./+@:-]+$/;

const REQUIRED_BWRAP_ARGUMENTS = Object.freeze([
  " --new-session",
  " --die-with-parent",
  " --unshare-net",
  " --unshare-pid",
  " --unshare-user",
  " --cap-drop ALL",
  " --ro-bind / / ",
]);

export class LinuxSandboxUnavailableError extends Error {
  constructor(missing) {
    super(
      `The Linux sandbox is unavailable: ${missing.join("; ")}. Run the AgentLink Linux sandbox check for install steps.`,
    );
    this.name = "LinuxSandboxUnavailableError";
    this.missing = missing;
  }
}

function defaultIsExecutableFile(filePath) {
  try {
    const metadata = lstatSync(filePath);
    if (!metadata.isFile()) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `vendor/seccomp/<arch>/apply-seccomp` under the staged runtime root. */
export function linuxApplySeccompPath(runtimeRoot, architecture) {
  return path.join(
    runtimeRoot,
    "vendor",
    "seccomp",
    architecture,
    "apply-seccomp",
  );
}

/**
 * Resolves the tools the Linux sandbox needs, or throws listing every missing
 * one. `runtimeRoot` is the staged `dist/sandbox-runtime` directory.
 */
export function resolveLinuxSandboxTools({
  runtimeRoot,
  architecture = process.arch,
  environment = process.env,
  isExecutableFile = defaultIsExecutableFile,
}) {
  const missing = [];
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new LinuxSandboxUnavailableError([
      `architecture ${architecture} is not supported`,
    ]);
  }
  const bwrapPath = isExecutableFile(LINUX_BWRAP_PATH)
    ? LINUX_BWRAP_PATH
    : undefined;
  if (!bwrapPath)
    missing.push(`bubblewrap is not installed at ${LINUX_BWRAP_PATH}`);
  const socatPath = LINUX_SOCAT_CANDIDATES.find(isExecutableFile);
  if (!socatPath) missing.push("socat is not installed");
  const hostRipgrep = environment[LINUX_RIPGREP_ENVIRONMENT_KEY];
  const ripgrepPath =
    hostRipgrep && path.isAbsolute(hostRipgrep) && isExecutableFile(hostRipgrep)
      ? hostRipgrep
      : LINUX_RIPGREP_CANDIDATES.find(isExecutableFile);
  if (!ripgrepPath) missing.push("ripgrep is not available");
  const applySeccompPath = linuxApplySeccompPath(runtimeRoot, architecture);
  if (!isExecutableFile(applySeccompPath)) {
    missing.push(
      "the apply-seccomp helper is missing, so unix sockets cannot be blocked",
    );
  }
  if (missing.length > 0) throw new LinuxSandboxUnavailableError(missing);
  for (const toolPath of [bwrapPath, socatPath, applySeccompPath]) {
    if (!SIMPLE_PATH.test(toolPath)) {
      throw new LinuxSandboxUnavailableError([
        `sandbox tool path needs shell quoting, which is not supported: ${toolPath}`,
      ]);
    }
  }
  return Object.freeze({ bwrapPath, socatPath, ripgrepPath, applySeccompPath });
}

/** Sandbox runtime configuration for the resolved Linux tools. */
export function linuxSandboxRuntimeConfig(tools) {
  return {
    bwrapPath: tools.bwrapPath,
    socatPath: tools.socatPath,
    ripgrep: { command: tools.ripgrepPath },
    seccomp: { applyPath: tools.applySeccompPath },
    enableWeakerNestedSandbox: false,
  };
}

function countOf(source, search) {
  return source.split(search).length - 1;
}

/**
 * Checks the runtime returned the inline bubblewrap launch AgentLink reviewed:
 * the user's shell runs bwrap with a read-only root, private network, PID and
 * user namespaces and no capabilities, and the command runs once under
 * apply-seccomp. Anything else, including the runtime's args-file form for
 * very large profiles, is rejected.
 */
export function isLinuxSandboxRuntimeDescriptor(
  argv,
  request,
  tools,
  { euid = process.geteuid?.() } = {},
) {
  if (
    argv.length !== 3 ||
    argv[0] !== request.shell ||
    argv[1] !== "-c" ||
    argv[2] === request.command ||
    !SIMPLE_PATH.test(request.shell)
  ) {
    return false;
  }
  const wrapper = argv[2];
  if (Buffer.byteLength(wrapper, "utf8") >= LINUX_MAX_ARGUMENT_BYTES) {
    return false;
  }
  if (!wrapper.startsWith(`${tools.bwrapPath} `)) return false;
  const separator = wrapper.indexOf(" -- ");
  if (separator === -1) return false;
  const bwrapArguments = `${wrapper.slice(0, separator)} `;
  if (
    !REQUIRED_BWRAP_ARGUMENTS.every((argument) =>
      bwrapArguments.includes(argument),
    ) ||
    bwrapArguments.includes("--share-net") ||
    bwrapArguments.includes("--args ")
  ) {
    return false;
  }
  // A root caller gets CAP_SETFCAP for apply-seccomp's nested namespace;
  // nobody gets anything else.
  const capabilityAdds = countOf(bwrapArguments, "--cap-add");
  if (
    capabilityAdds > 1 ||
    (capabilityAdds === 1 &&
      (euid !== 0 || !bwrapArguments.includes(" --cap-add CAP_SETFCAP ")))
  ) {
    return false;
  }
  const seccompLaunch = `${tools.applySeccompPath} ${request.shell} -c `;
  return countOf(wrapper.slice(separator), seccompLaunch) === 1;
}

function replaceExactCount(source, search, replacement, expectedCount, label) {
  const actualCount = countOf(source, search);
  if (actualCount !== expectedCount) {
    throw new Error(
      `sandbox runtime proxy contract drifted for ${label}: expected ${expectedCount}, found ${actualCount}`,
    );
  }
  return source.split(search).join(replacement);
}

/**
 * Adds the session's proxy credentials to the in-sandbox proxy URLs. Exact
 * counts make an unreviewed runtime change fail closed.
 */
export function bindLinuxProxyCredentials(
  argv,
  request,
  tools,
  networkProxies,
  options,
) {
  if (!isLinuxSandboxRuntimeDescriptor(argv, request, tools, options)) {
    throw new Error(
      "cannot authenticate an unexpected sandbox runtime descriptor",
    );
  }
  // No proxy variables means no route out of the private network namespace.
  if (
    countOf(argv[2], LINUX_HTTP_PROXY_URL) === 0 &&
    countOf(argv[2], LINUX_SOCKS_PROXY_URL) === 0
  ) {
    if (
      argv[2].includes("localhost:3128") ||
      argv[2].includes("localhost:1080")
    ) {
      throw new Error(
        "sandbox runtime proxy contract contains unexpected proxy credentials or URL syntax",
      );
    }
    return argv;
  }
  const { username, password } = networkProxies.credentials;
  if (
    !/^[A-Za-z0-9_-]{1,32}$/.test(username) ||
    !/^[a-f0-9]{64}$/.test(password)
  ) {
    throw new Error("network proxy returned invalid session credentials");
  }
  let wrapper = replaceExactCount(
    argv[2],
    LINUX_HTTP_PROXY_URL,
    `http://${username}:${password}@localhost:3128`,
    LINUX_HTTP_PROXY_URL_COUNT,
    "HTTP proxy URLs",
  );
  wrapper = replaceExactCount(
    wrapper,
    LINUX_SOCKS_PROXY_URL,
    `socks5h://${username}:${password}@localhost:1080`,
    LINUX_SOCKS_PROXY_URL_COUNT,
    "SOCKS proxy URLs",
  );
  const authenticated = [argv[0], argv[1], wrapper];
  if (
    !isLinuxSandboxRuntimeDescriptor(authenticated, request, tools, options)
  ) {
    throw new Error(
      "authenticated sandbox runtime descriptor failed validation",
    );
  }
  return authenticated;
}
