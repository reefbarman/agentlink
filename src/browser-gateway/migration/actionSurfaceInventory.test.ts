import * as fs from "fs";
import * as path from "path";

import {
  ASK_AGENT_ACTION_INVENTORY,
  BROWSER_GATEWAY_ACTION_SURFACE_INVENTORY,
  BROWSER_GATEWAY_PROTOCOL_COMMAND_ADOPTION,
  VSCODE_GATEWAY_ACTION_INVENTORY,
} from "./actionSurfaceInventory.js";
import { describe, expect, it } from "vitest";

import { ASK_AGENT_ROUTES } from "../helper/helperRouteFamilies.js";
import { BROWSER_GATEWAY_OWNER_COMMAND_KINDS } from "../dataPlane/protocol.js";

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function sourcePath(routeKind: string, path: string): string {
  if (routeKind.includes("prefix")) return `${path}*`;
  return path;
}

function vscodeBrowserRoutesFromSource(): string[] {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/browser-gateway/BrowserGatewayServer.ts"),
    "utf8",
  );
  const createRoutes = source.slice(
    source.indexOf("  private createHttpRoutes()"),
    source.indexOf("  private async handleSse("),
  );
  const matches = [
    ...createRoutes.matchAll(
      /route\(\s*"(GET|POST|DELETE)"\s*,\s*(?:(rawExact|pathExact)\("([^"]+)"\)|match\("(raw-prefix|path-prefix)",\s*"([^"]+)"\))/g,
    ),
  ];
  const routeCallCount = [...createRoutes.matchAll(/\broute\(/g)].length;
  if (matches.length !== routeCallCount) {
    throw new Error(
      `Unrecognized BrowserGatewayServer route declaration: parsed ${matches.length} of ${routeCallCount}`,
    );
  }

  return matches
    .map((match) => ({
      method: match[1]!,
      routeKind: (match[2] ?? match[4])!,
      path: (match[3] ?? match[5])!,
    }))
    .filter(({ path }) => path === "/events" || path.startsWith("/api/"))
    .map(({ method, routeKind, path }) =>
      routeKey(method, sourcePath(routeKind, path)),
    )
    .sort();
}

describe("browser gateway action-surface inventory", () => {
  it("classifies every browser-visible VS Code gateway route", () => {
    const inventoryRoutes = VSCODE_GATEWAY_ACTION_INVENTORY.map((entry) =>
      routeKey(entry.method, entry.path),
    ).sort();

    expect(inventoryRoutes).toEqual(vscodeBrowserRoutesFromSource());
  });

  it("classifies every helper-owned Ask Agent route", () => {
    const actual = ASK_AGENT_ACTION_INVENTORY.map((entry) =>
      routeKey(entry.method, entry.path),
    ).sort();
    const expected = ASK_AGENT_ROUTES.map((route) =>
      routeKey(route.method, route.path),
    ).sort();

    expect(actual).toEqual(expected);
  });

  it("keeps inventory entries unique and documented", () => {
    const keys = BROWSER_GATEWAY_ACTION_SURFACE_INVENTORY.map((entry) =>
      routeKey(entry.method, `${entry.surface}:${entry.path}`),
    );

    expect(new Set(keys).size).toBe(keys.length);
    expect(
      BROWSER_GATEWAY_ACTION_SURFACE_INVENTORY.every(
        (entry) => entry.notes.trim().length > 0,
      ),
    ).toBe(true);
    expect(
      BROWSER_GATEWAY_ACTION_SURFACE_INVENTORY.every(
        (entry) =>
          entry.disposition !== "protocol_command" ||
          typeof entry.commandKind === "string",
      ),
    ).toBe(true);
  });

  it("tracks adoption for every declared protocol command kind", () => {
    expect(
      BROWSER_GATEWAY_PROTOCOL_COMMAND_ADOPTION.map(
        (entry) => entry.commandKind,
      ),
    ).toEqual(BROWSER_GATEWAY_OWNER_COMMAND_KINDS);
    expect(
      BROWSER_GATEWAY_PROTOCOL_COMMAND_ADOPTION.every(
        (entry) => entry.routes.length > 0 && entry.notes.trim().length > 0,
      ),
    ).toBe(true);
  });

  it("marks only implemented protocol commands as routed", () => {
    expect(
      BROWSER_GATEWAY_PROTOCOL_COMMAND_ADOPTION.filter(
        (entry) => entry.status === "routed",
      ).map((entry) => entry.commandKind),
    ).toEqual(["session.detail"]);
  });
});
