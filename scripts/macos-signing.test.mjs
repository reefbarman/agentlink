import { afterEach, mock, test } from "node:test";
import {
  resolveSigningPolicy,
  signMacBinary,
  verifyMacSignature,
} from "./macos-signing.mjs";

import assert from "node:assert/strict";
import { assertDesktopStopped } from "./install-desktop.mjs";
import childProcess from "node:child_process";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

const hashA = "A".repeat(40);
const hashB = "B".repeat(40);
const signingInfo = (entries) =>
  `${entries.map(([hash, name], index) => `  ${index + 1}) ${hash} "Apple Development: ${name}"`).join("\n")}\n     ${entries.length} valid identities found\n`;

afterEach(() => {
  mock.restoreAll();
  Object.defineProperty(process, "platform", originalPlatform);
});

function mockMacOS() {
  Object.defineProperty(process, "platform", { value: "darwin" });
}

test("unsigned is an explicit opt-out and does not query Keychain", () => {
  mock.method(childProcess, "execFileSync", () => {
    throw new Error("unexpected Keychain lookup");
  });
  assert.deepEqual(
    resolveSigningPolicy({ mode: "unsigned", identity: undefined }),
    {
      mode: "unsigned",
    },
  );
  assert.throws(
    () => resolveSigningPolicy({ mode: "unsigned", identity: hashA }),
    /identity cannot/,
  );
  assert.throws(
    () => resolveSigningPolicy({ mode: "adhoc" }),
    /Invalid AGENTLINK_MAC_SIGNING/,
  );
});

test("development selects the sole valid Apple Development identity", () => {
  mockMacOS();
  mock.method(childProcess, "execFileSync", () =>
    signingInfo([[hashA, "Developer (TEAM)"]]),
  );
  assert.deepEqual(
    resolveSigningPolicy({ mode: "development", identity: undefined }),
    {
      mode: "development",
      identity: hashA,
    },
  );
});

test("development rejects missing, ambiguous and non-matching selectors", () => {
  mockMacOS();
  mock.method(childProcess, "execFileSync", () => signingInfo([]));
  assert.throws(
    () => resolveSigningPolicy({ mode: "development", identity: undefined }),
    /found 0/,
  );
  mock.restoreAll();
  mock.method(childProcess, "execFileSync", () =>
    signingInfo([
      [hashA, "One (TEAM)"],
      [hashB, "Two (TEAM)"],
    ]),
  );
  assert.throws(
    () => resolveSigningPolicy({ mode: "development", identity: undefined }),
    /found 2/,
  );
  assert.equal(
    resolveSigningPolicy({ mode: "development", identity: hashB.toLowerCase() })
      .identity,
    hashB,
  );
  assert.equal(
    resolveSigningPolicy({
      mode: "development",
      identity: "Apple Development: One (TEAM)",
    }).identity,
    hashA,
  );
  assert.throws(
    () =>
      resolveSigningPolicy({
        mode: "development",
        identity: "Developer ID Application: One (TEAM)",
      }),
    /found 0/,
  );
});

test("signMacBinary passes stable identifier without ad-hoc or deep signing", () => {
  const calls = [];
  mock.method(childProcess, "execFileSync", (file, args) => {
    calls.push([file, args]);
    return "";
  });
  mock.method(childProcess, "spawnSync", () => ({
    status: 0,
    stdout: "",
    stderr:
      "Identifier=com.agentlink.cli.node\nTeamIdentifier=TEAM\nAuthority=Apple Development: Developer (TEAM)\nCodeDirectory v=20400 flags=0x0(none)\n",
  }));
  signMacBinary("/tmp/node", {
    identity: hashA,
    identifier: "com.agentlink.cli.node",
  });
  assert.deepEqual(calls[0], [
    "codesign",
    [
      "--force",
      "--sign",
      hashA,
      "--identifier",
      "com.agentlink.cli.node",
      "--timestamp=none",
      "/tmp/node",
    ],
  ]);
  assert.throws(
    () =>
      signMacBinary("/tmp/node", {
        identity: "-",
        identifier: "com.agentlink.cli.node",
      }),
    /certificate identity/,
  );
});

test("signature verification rejects ad-hoc and wrong identifiers", () => {
  mock.method(childProcess, "execFileSync", () => "");
  const display = mock.method(childProcess, "spawnSync", () => ({
    status: 0,
    stdout: "",
    stderr:
      "Identifier=com.agentlink.desktop\nTeamIdentifier=TEAM\nAuthority=Apple Development: Developer (TEAM)\nCodeDirectory v=20400 flags=0x0(none)\n",
  }));
  assert.equal(
    verifyMacSignature("AgentLink.app", {
      identifier: "com.agentlink.desktop",
      deep: true,
    }).identifier,
    "com.agentlink.desktop",
  );
  assert.throws(
    () => verifyMacSignature("AgentLink.app", { identifier: "other" }),
    /Expected signature identifier/,
  );
  display.mock.mockImplementation(() => ({
    status: 0,
    stdout: "",
    stderr:
      "Identifier=com.agentlink.desktop\nTeamIdentifier=not set\nCodeDirectory v=20400 flags=0x2(adhoc)\n",
  }));
  assert.throws(
    () => verifyMacSignature("AgentLink.app"),
    /certificate-backed/,
  );
});

test("installer refuses live app and helper processes but not unrelated commands", () => {
  assertDesktopStopped(" 123 /usr/bin/node /tmp/other.js\n", 999);
  assertDesktopStopped(
    " 123 /Applications/Visual Studio Code.app/Contents/MacOS/Electron /extension/dist/browser-gateway-helper.js\n",
    999,
  );
  assert.throws(
    () =>
      assertDesktopStopped(
        " 123 /Applications/AgentLink.app/Contents/MacOS/AgentLink\n",
        999,
      ),
    /Quit AgentLink/,
  );
  assert.throws(
    () =>
      assertDesktopStopped(
        " 123 /Applications/AgentLink.app/Contents/MacOS/AgentLink /runtime/dist/browser-gateway-helper.js\n",
        999,
      ),
    /Quit AgentLink/,
  );
  assertDesktopStopped(
    " 999 /Applications/AgentLink.app/Contents/MacOS/AgentLink\n",
    999,
  );
});
