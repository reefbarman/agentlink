import {
  cleanUpInstallFixtures,
  container,
  image,
  installed,
} from "./guidedInstallHarness.js";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { describe, expect, it } from "vitest";

import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Split from guidedInstall.test.ts so Vitest can run the slow installer
// scenarios in parallel. Recovery and uninstall are in
// guidedInstallRecovery.test.ts.
cleanUpInstallFixtures();

describe(
  "installer optional features, uninstall and recovery",
  {
    timeout: 30_000,
  },
  () => {
    it("turns a feature on and off with only the installed release's template and image", () => {
      const f = installed();
      const env = f.read(".env");
      const config = f.read("server.json");
      const listed = f.run(["capabilities"]);
      expect(listed.status).toBe(0);
      expect(listed.stdout).toMatch(
        /editor\s+Edit task workspaces\s+disabled/u,
      );
      expect(listed.stdout).toMatch(
        /browser\s+Research with a browser\s+disabled/u,
      );
      expect(listed.stdout).toContain("Meridian");

      const enabled = f.run(["enable", "editor", "--yes"]);
      expect(enabled.stderr).toBe("");
      expect(enabled.status).toBe(0);
      expect(enabled.stdout).toContain("Port 8444 will listen");
      expect(f.read(".env")).toContain(
        "COMPOSE_FILE=compose.yaml:compose.publisher.yaml:compose.runners.yaml:compose.backup.yaml:compose.update-client.yaml:compose.editor.yaml\n",
      );
      const withEditor = JSON.parse(f.read("server.json"));
      expect(withEditor.editor).toEqual({ port: 8444 });
      expect(statSync(join(f.deploy, "server.json")).mode & 0o777).toBe(0o600);
      expect(f.read("compose.editor.yaml")).toBe(
        readFileSync(join(container, "compose.editor.yaml"), "utf8"),
      );
      const steps = f
        .dockerCalls()
        .map((call) =>
          call.args[0] === "pull" || call.args[0] === "tag"
            ? call.args.join(" ")
            : call.args.includes("drain")
              ? "drain"
              : call.args.includes("backup")
                ? "backup"
                : call.args.includes("up")
                  ? "up"
                  : call.args.includes("resume")
                    ? "resume"
                    : "",
        )
        .filter(Boolean);
      expect(steps).toEqual([
        `pull ${image("editor")}`,
        "drain",
        "backup",
        `tag ${image("editor")} agentlink-editor:local`,
        "up",
        "resume",
      ]);
      expect(f.journal()).toMatchObject({
        schemaVersion: 1,
        action: "enable",
        capability: "editor",
        status: "completed",
      });
      expect(existsSync(f.lock)).toBe(false);
      expect(
        readFileSync(join(f.updater, "lifecycle-recovery", "env"), "utf8"),
      ).toBe(env);
      expect(f.run(["capabilities"]).stdout).toMatch(/editor\s.*\senabled/u);
      // Asking again changes nothing.
      rmSync(f.log, { force: true });
      expect(f.run(["enable", "editor", "--yes"]).stdout).toContain(
        "already on",
      );
      expect(f.dockerCalls().some((call) => call.args[0] === "pull")).toBe(
        false,
      );

      const disabled = f.run(["disable", "editor", "--yes"], {
        TEST_CHILDREN: "1",
      });
      expect(disabled.status).toBe(0);
      expect(f.read(".env")).toBe(env);
      expect(f.read("server.json")).toBe(config);
      // The open editor is closed; the template stays for a later enable.
      expect(
        f
          .dockerCalls()
          .some((call) => call.args.join(" ") === "rm -f c0ffee00c0ff"),
      ).toBe(true);
      // A container that only shares the label is never touched.
      expect(
        f.dockerCalls().some((call) => call.args.includes("badd00dbadd0")),
      ).toBe(false);
      expect(existsSync(join(f.deploy, "compose.editor.yaml"))).toBe(true);
      expect(f.journal()).toMatchObject({
        action: "disable",
        status: "completed",
      });
    });

    it("retires an update's rollback point when a feature changes, so rollback stops nothing (update, enable editor, rollback)", () => {
      const f = installed();
      // A browser update to this release added compose.editor.yaml, which
      // had no earlier copy: its rollback would remove it.
      const previous = join(f.deploy, ".upgrade-assets-previous");
      mkdirSync(previous);
      copyFileSync(
        join(f.deploy, "compose.yaml"),
        join(previous, "compose.yaml"),
      );
      writeFileSync(
        join(previous, ".files"),
        "compose.yaml\ncompose.editor.yaml\n",
      );
      writeFileSync(
        join(f.deploy, ".upgrade-state"),
        "status=done\nstarted=2026-10-18T00:00:00Z\ncommit=aaaaaaaa\nsnapshot=abcdef12\nrelease=0\nassets=1\n",
      );

      const enabled = f.run(["enable", "editor", "--yes"]);
      expect(enabled.status).toBe(0);
      expect(enabled.stdout).toContain(
        "The last update can no longer be rolled back",
      );
      expect(f.read(".upgrade-state")).toContain("status=retired\n");
      expect(f.read(".upgrade-state")).toContain("snapshot=abcdef12\n");
      const env = f.read(".env");
      expect(env).toContain(":compose.editor.yaml\n");

      const rollback = () => {
        rmSync(f.log, { force: true });
        return spawnSync(
          process.env.AGENTLINK_TEST_BASH ?? "bash",
          [join(f.deploy, "upgrade.sh"), "--deploy", f.deploy, "rollback"],
          {
            encoding: "utf8",
            timeout: 15_000,
            env: {
              ...process.env,
              PATH: `${join(f.root, "bin")}:${process.env.PATH}`,
              TEST_LOG: f.log,
              TEST_ASSETS: f.assets,
              HOME: f.root,
              DOCKER_HOST: "",
              TEST_EXISTING_IMAGES: "1",
            },
          },
        );
      };
      const expectNothingStopped = () => {
        expect(f.compose("stop")).toEqual([]);
        expect(f.compose("up")).toEqual([]);
        expect(f.read(".env")).toBe(env);
        expect(existsSync(join(f.deploy, "compose.editor.yaml"))).toBe(true);
      };
      const retired = rollback();
      expect(retired.status).not.toBe(0);
      expect(retired.stderr).toContain("can no longer be rolled back");
      expect(retired.stdout).not.toContain("AGENTLINK_UPDATE_PHASE");
      expectNothingStopped();

      // Even a rollback point that was not retired never removes a
      // template the current .env uses.
      writeFileSync(
        join(f.deploy, ".upgrade-state"),
        f.read(".upgrade-state").replace("status=retired", "status=done"),
      );
      const active = rollback();
      expect(active.status).not.toBe(0);
      expect(active.stderr).toContain(
        "would remove compose.editor.yaml, which COMPOSE_FILE in .env uses now",
      );
      expectNothingStopped();
    });

    it("accepts only the fixed feature names", () => {
      const f = installed();
      for (const name of [
        "../compose.evil",
        "meridian",
        "compose.editor.yaml",
      ]) {
        const result = f.run(["enable", name, "--yes"]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("unknown optional feature");
      }
      expect(f.run(["enable", "--yes"]).stderr).toContain(
        "name the optional feature",
      );
      expect(f.run(["uninstall", "editor"]).stderr).toContain(
        "unexpected argument",
      );
      expect(f.calls()).toEqual([]);
    });

    it("puts the previous configuration back when the change does not start", () => {
      const f = installed();
      const env = f.read(".env");
      const config = f.read("server.json");
      const result = f.run(["enable", "browser", "--yes"], {
        TEST_DOCKER_FAIL: "config",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("change was undone");
      expect(f.read(".env")).toBe(env);
      expect(f.read("server.json")).toBe(config);
      expect(existsSync(join(f.deploy, "compose.browser.yaml"))).toBe(false);
      expect(f.journal()).toMatchObject({ status: "rolled-back" });
      expect(existsSync(f.lock)).toBe(false);
      // The drain is lifted after the old configuration is checked.
      expect(f.compose("exec", "-T", "assistant").at(-1)?.args).toContain(
        "resume",
      );
    });

    it("downloads and pulls before changing anything, and refuses a mismatched template", () => {
      const f = installed();
      const env = f.read(".env");
      writeFileSync(join(f.assets, "compose.editor.yaml"), "services: {}\n");
      const result = f.run(["enable", "editor", "--yes"]);
      expect(result.stderr).toContain("does not match this release");
      expect(f.read(".env")).toBe(env);
      expect(existsSync(join(f.deploy, "compose.editor.yaml"))).toBe(false);
      expect(f.dockerCalls().some((call) => call.args.includes("drain"))).toBe(
        false,
      );
      expect(existsSync(f.lock)).toBe(false);
    });

    it("refuses while an update holds the guard or has not settled, changing nothing", () => {
      const f = installed();
      const env = f.read(".env");
      mkdirSync(f.lock);
      writeFileSync(join(f.lock, "owner"), "kind=update\nid=x\n");
      const busy = f.run(["enable", "editor", "--yes"]);
      expect(busy.stderr).toContain("holds");
      expect(busy.stderr).toContain("kind=update");
      // Another command's guard is never removed.
      expect(existsSync(join(f.lock, "owner"))).toBe(true);
      expect(f.run(["recover", "--yes"]).stderr).toContain(
        "never clears an update's guard",
      );
      rmSync(f.lock, { recursive: true });

      writeFileSync(
        join(f.deploy, ".upgrade-state"),
        "status=rollback-failed\n",
      );
      expect(f.run(["enable", "editor", "--yes"]).stderr).toContain(
        "not settled (status rollback-failed)",
      );
      writeFileSync(join(f.deploy, ".upgrade-state"), "status=done\n");
      const id = "11111111-2222-4333-8444-555555555555";
      mkdirSync(join(f.updater, "operations"));
      writeFileSync(
        join(f.updater, "current-operation.json"),
        JSON.stringify({ id }),
      );
      writeFileSync(
        join(f.updater, "operations", `${id}.json`),
        JSON.stringify({ id, kind: "update", phase: "draining" }),
      );
      expect(f.run(["uninstall", "--yes"]).stderr).toContain(
        "browser update is draining",
      );
      writeFileSync(
        join(f.updater, "operations", `${id}.json`),
        JSON.stringify({ id, kind: "update", phase: "interrupted" }),
      );
      expect(f.run(["disable", "editor", "--yes"]).status).toBe(0); // already off
      expect(f.run(["enable", "editor", "--yes"]).stderr).toContain(
        "was interrupted",
      );
      expect(f.read(".env")).toBe(env);
      // The refusal comes before any download, pull or drain.
      expect(f.dockerCalls().some((call) => call.args[0] === "pull")).toBe(
        false,
      );
      expect(f.dockerCalls().some((call) => call.args.includes("drain"))).toBe(
        false,
      );
      expect(existsSync(f.lock)).toBe(false);
    });
  },
);
