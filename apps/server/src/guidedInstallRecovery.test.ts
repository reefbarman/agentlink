import { cleanUpInstallFixtures, installed } from "./guidedInstallHarness.js";
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import { join } from "node:path";

// Split from guidedInstallFeatures.test.ts so Vitest can run the slow
// installer scenarios in parallel.
cleanUpInstallFixtures();

describe(
  "installer optional features, uninstall and recovery",
  {
    timeout: 30_000,
  },
  () => {
    it("keeps an interrupted change blocked until recover puts the saved files back", () => {
      const f = installed();
      const env = f.read(".env");
      const config = f.read("server.json");
      // As if killed after changing .env: guard, journal and recovery set left.
      const recovery = join(f.updater, "lifecycle-recovery");
      mkdirSync(recovery);
      writeFileSync(join(recovery, "env"), env);
      writeFileSync(join(recovery, "server.json"), config);
      writeFileSync(join(recovery, "templates"), "compose.yaml\n");
      writeFileSync(join(recovery, "id"), "1-2\n");
      writeFileSync(
        join(f.updater, ".lifecycle-state.json"),
        `${JSON.stringify({ schemaVersion: 1, id: "1-2", action: "enable", capability: "editor", status: "applying", updatedAt: 1 })}\n`,
      );
      mkdirSync(f.lock);
      writeFileSync(join(f.lock, "owner"), "kind=capability\npid=999999\n");
      writeFileSync(join(f.deploy, ".env"), `${env}# half-written\n`);

      const blocked = f.run(["enable", "browser", "--yes"]);
      expect(blocked.status).not.toBe(0);
      expect(blocked.stderr).toContain("recover");
      rmSync(f.lock, { recursive: true });
      // Even with the guard gone, the journal still blocks.
      expect(f.run(["uninstall", "--yes"]).stderr).toContain(
        "did not finish (status applying)",
      );

      const recovered = f.run(["recover", "--yes"]);
      expect(recovered.stderr).toBe("");
      expect(recovered.status).toBe(0);
      expect(f.read(".env")).toBe(env);
      expect(f.read("server.json")).toBe(config);
      expect(f.journal()).toMatchObject({ id: "1-2", status: "recovered" });
      expect(existsSync(f.lock)).toBe(false);
      expect(f.run(["recover", "--yes"]).stdout).toContain(
        "Nothing to recover",
      );
    });

    it("does not recover from a saved set that belongs to another change", () => {
      const f = installed();
      const recovery = join(f.updater, "lifecycle-recovery");
      mkdirSync(recovery);
      for (const name of ["env", "server.json", "templates"])
        writeFileSync(join(recovery, name), "x\n");
      writeFileSync(join(recovery, "id"), "other\n");
      writeFileSync(
        join(f.updater, ".lifecycle-state.json"),
        `${JSON.stringify({ schemaVersion: 1, id: "1-2", action: "disable", capability: "browser", status: "applying", updatedAt: 1 })}\n`,
      );
      const result = f.run(["recover", "--yes"]);
      expect(result.stderr).toContain("does not match the unfinished change");
      expect(f.read(".env")).not.toBe("x\n");
      // Still blocked, and the guard is kept for the operator.
      expect(existsSync(f.lock)).toBe(true);
    });

    it("refuses modified templates and an unreadable journal before running Compose", () => {
      const f = installed();
      const compose = f.read("compose.yaml");
      writeFileSync(join(f.deploy, "compose.yaml"), `${compose}# edited\n`);
      const edited = f.run(["uninstall", "--yes"]);
      expect(edited.status).not.toBe(0);
      expect(edited.stderr).toContain("differs from this release's copy");
      expect(f.run(["enable", "browser", "--yes"]).stderr).toContain(
        "differs from this release's copy",
      );
      writeFileSync(join(f.deploy, "compose.yaml"), compose);

      const supervisor = readFileSync(join(f.updater, "compose.yaml"), "utf8");
      writeFileSync(join(f.updater, "compose.yaml"), `${supervisor}# edited\n`);
      expect(f.run(["uninstall", "--yes"]).stderr).toContain(
        `${f.updater}/compose.yaml differs`,
      );
      writeFileSync(join(f.updater, "compose.yaml"), supervisor);
      expect(f.compose("down")).toEqual([]);

      for (const broken of [
        "{not json",
        JSON.stringify({ status: "completed" }),
      ]) {
        writeFileSync(join(f.updater, ".lifecycle-state.json"), broken);
        const recovered = f.run(["recover", "--yes"]);
        expect(recovered.status).not.toBe(0);
        expect(recovered.stderr).toContain("cannot be read");
        expect(f.run(["enable", "editor", "--yes"]).stderr).toContain(
          "status unreadable",
        );
      }
      expect(f.dockerCalls().some((call) => call.args[0] === "pull")).toBe(
        false,
      );
    });

    it("uninstalls without deleting anything and resumes the same installation", () => {
      const f = installed();
      const files = [
        join(f.deploy, "server.json"),
        join(f.deploy, "secrets", "backup-password"),
        join(f.deploy, "data", "settings", "onboarding.json"),
        join(f.updater, "updater-token"),
        join(`${f.deploy}-witness`, "compose.yaml"),
      ];
      const before = files.map((file) => readFileSync(file, "utf8"));
      const result = f.run(["uninstall", "--yes"], { TEST_CHILDREN: "1" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Nothing is deleted");
      expect(result.stdout).toContain("resume --deploy");
      expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);
      const downs = f.compose("down");
      expect(downs.map((call) => realpathSync(call.cwd))).toEqual(
        [f.deploy, f.updater, `${f.deploy}-witness`].map((dir) =>
          realpathSync(dir),
        ),
      );
      // Never a volume, image or system-wide removal.
      expect(
        f
          .dockerCalls()
          .some(
            (call) =>
              call.args.includes("-v") ||
              call.args.includes("--volumes") ||
              call.args.includes("--rmi") ||
              call.args.includes("prune"),
          ),
      ).toBe(false);
      expect(
        f
          .dockerCalls()
          .filter((call) => call.args.join(" ") === "rm -f c0ffee00c0ff"),
      ).toHaveLength(3);
      expect(
        f.dockerCalls().some((call) => call.args.includes("badd00dbadd0")),
      ).toBe(false);
      expect(result.stdout).toContain("1 runner container(s)");
      expect(f.journal()).toMatchObject({
        action: "uninstall",
        status: "uninstalled",
      });
      expect(existsSync(f.lock)).toBe(false);
      expect(f.run(["enable", "editor", "--yes"]).stderr).toContain(
        "uninstalled; start it again first",
      );

      rmSync(f.log, { force: true });
      const resumed = f.run(["resume", "--yes"]);
      expect(resumed.status).toBe(0);
      expect(
        f.compose("up", "-d").map((call) => realpathSync(call.cwd)),
      ).toEqual(
        [`${f.deploy}-witness`, f.updater, f.deploy].map((dir) =>
          realpathSync(dir),
        ),
      );
      expect(f.compose("exec", "-T", "assistant").at(-1)?.args).toContain(
        "resume",
      );
      expect(f.journal()).toMatchObject({ status: "resumed" });
      expect(f.run(["resume", "--yes"]).stdout).toContain("nothing to resume");
    });

    it("refuses an installation whose release predates the guard, or a hand-edited configuration", () => {
      const f = installed();
      const metadata = join(f.deploy, "assistant-deployment.json");
      const original = readFileSync(metadata, "utf8");
      writeFileSync(
        metadata,
        original.replace(/^\s*"lifecycleProtocol": 1,\n/mu, ""),
      );
      expect(f.run(["enable", "editor", "--yes"]).stderr).toContain(
        "predates safe optional-feature changes",
      );
      writeFileSync(metadata, original);
      const config = f.read("server.json");
      writeFileSync(
        join(f.deploy, "server.json"),
        config.replace(
          '  "projectsRoot"',
          '  "browser": {"idleMinutes": 5},\n  "projectsRoot"',
        ),
      );
      expect(f.run(["enable", "browser", "--yes"]).stderr).toContain(
        "set up by hand",
      );
      writeFileSync(join(f.deploy, "server.json"), config);
      writeFileSync(
        join(f.deploy, ".env"),
        `${f.read(".env")}COMPOSE_FILE=compose.yaml\n`,
      );
      expect(f.run(["enable", "editor", "--yes"]).stderr).toContain(
        "exactly one COMPOSE_FILE",
      );
      expect(f.dockerCalls().some((call) => call.args[0] === "pull")).toBe(
        false,
      );
    });

    it("refuses the editor when port 8444 is taken", () => {
      const f = installed();
      const result = f.run(["enable", "editor", "--yes"], {
        TEST_PORT_BUSY: "1",
      });
      expect(result.stderr).toContain("port 8444 is already in use");
      expect(f.calls().some((call) => call.tool === "curl")).toBe(false);
    });
  },
);
