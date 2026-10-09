import {
  ServerAccessStore,
  csrfTokenForSession,
  issueLocalRecoveryCredential,
  verifyCsrfToken,
} from "./ServerAccessStore.js";
import { afterEach, describe, expect, it } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const PASSPHRASE = "correct horse battery staple";
const DAY = 24 * 60 * 60 * 1000;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function openStore(clock: { value: number }, dataRoot?: string) {
  const root =
    dataRoot ?? (await fs.mkdtemp(path.join(os.tmpdir(), "access-store-")));
  if (!dataRoot) roots.push(root);
  const store = await ServerAccessStore.open({
    dataRoot: root,
    now: () => clock.value,
    passphraseCost: { N: 1024, r: 8, p: 1 },
  });
  return { store, root };
}

async function bootstrapped(clock: { value: number }) {
  const { store, root } = await openStore(clock);
  const { token } = await store.issueSetupCredential();
  const issued = await store.bootstrapOwner({
    setupToken: token,
    passphrase: PASSPHRASE,
  });
  return { store, root, issued };
}

describe("server access store", () => {
  it("fails closed on a corrupt state file instead of reopening bootstrap", async () => {
    const clock = { value: Date.now() };
    const { store, root } = await bootstrapped(clock);
    await store.close();
    await fs.writeFile(path.join(root, "access-state.json"), "{not json");
    await expect(openStore(clock, root)).rejects.toMatchObject({
      code: "access_state_corrupt",
    });
    await fs.writeFile(
      path.join(root, "access-state.json"),
      JSON.stringify({ schemaVersion: 1 }),
    );
    await expect(openStore(clock, root)).rejects.toMatchObject({
      code: "access_state_corrupt",
    });
  });

  it("expires setup credentials and refuses to reissue after bootstrap", async () => {
    const clock = { value: Date.now() };
    const { store } = await openStore(clock);
    const { token } = await store.issueSetupCredential();
    clock.value += 15 * 60 * 1000;
    await expect(
      store.bootstrapOwner({ setupToken: token, passphrase: PASSPHRASE }),
    ).rejects.toMatchObject({ code: "invalid_setup_credential" });
    const fresh = await store.issueSetupCredential();
    await store.bootstrapOwner({
      setupToken: fresh.token,
      passphrase: PASSPHRASE,
    });
    await expect(store.issueSetupCredential()).rejects.toMatchObject({
      code: "owner_exists",
    });
  });

  it("applies idle and absolute session expiry", async () => {
    const clock = { value: Date.now() };
    const { store, issued } = await bootstrapped(clock);
    clock.value += 6 * DAY;
    await expect(store.authenticate(issued.token)).resolves.toMatchObject({
      ok: true,
    });
    clock.value += 7 * DAY;
    await expect(store.authenticate(issued.token)).resolves.toEqual({
      ok: false,
      reason: "expired",
    });

    const second = await bootstrappedSessionKeptAlive(clock);
    await expect(second.store.authenticate(second.token)).resolves.toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("lets only one store own a data root and replaces stale locks", async () => {
    const clock = { value: Date.now() };
    const { store, root } = await bootstrapped(clock);
    await expect(openStore(clock, root)).rejects.toMatchObject({
      code: "access_state_locked",
    });
    await store.close();
    await expect(store.revokeSession("anything")).resolves.toBe(false);
    const reopened = await openStore(clock, root);
    expect(reopened.store.ownerConfigured).toBe(true);
    await reopened.store.close();

    // A lock left by a process that no longer exists does not block startup.
    await fs.writeFile(
      path.join(root, "access-state.lock"),
      JSON.stringify({ pid: 2 ** 22 + 12_345, token: "stale" }),
    );
    const recovered = await openStore(clock, root);
    expect(recovered.store.ownerConfigured).toBe(true);
    await recovered.store.close();
    await expect(
      fs.stat(path.join(root, "access-state.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers access locally after the last device is revoked", async () => {
    const clock = { value: Date.now() };
    const { store, root, issued } = await bootstrapped(clock);
    await expect(store.revokeDevice(issued.session.deviceId)).resolves.toBe(
      true,
    );
    // Revoked sessions are pruned from disk, so the token is simply unknown.
    await expect(store.authenticate(issued.token)).resolves.toMatchObject({
      ok: false,
    });

    // The local command works while the server holds the data-root lock.
    const { token } = await issueLocalRecoveryCredential({
      dataRoot: root,
      now: () => clock.value,
    });
    const requestPath = path.join(root, "recovery-request.json");
    expect((await fs.stat(requestPath)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(requestPath, "utf8")).not.toContain(token);

    await expect(
      store.redeemRecovery({ recoveryToken: token, passphrase: "wrong" }),
    ).rejects.toMatchObject({ code: "invalid_recovery_credential" });
    await expect(
      store.redeemRecovery({
        recoveryToken: "x".repeat(43),
        passphrase: PASSPHRASE,
      }),
    ).rejects.toMatchObject({ code: "invalid_recovery_credential" });

    // A wrong passphrase does not burn the code; success consumes it.
    const recovered = await store.redeemRecovery({
      recoveryToken: token,
      passphrase: PASSPHRASE,
      deviceLabel: "Recovered laptop",
    });
    expect(recovered.session.deviceLabel).toBe("Recovered laptop");
    await expect(store.authenticate(recovered.token)).resolves.toMatchObject({
      ok: true,
    });
    await expect(fs.stat(requestPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      store.redeemRecovery({ recoveryToken: token, passphrase: PASSPHRASE }),
    ).rejects.toMatchObject({ code: "invalid_recovery_credential" });
  });

  it("expires, replaces, and rejects tampered recovery credentials", async () => {
    const clock = { value: Date.now() };
    const { store, root } = await bootstrapped(clock);
    const issue = () =>
      issueLocalRecoveryCredential({ dataRoot: root, now: () => clock.value });
    const requestPath = path.join(root, "recovery-request.json");

    const expired = await issue();
    clock.value += 15 * 60 * 1000;
    await expect(
      store.redeemRecovery({
        recoveryToken: expired.token,
        passphrase: PASSPHRASE,
      }),
    ).rejects.toMatchObject({ code: "invalid_recovery_credential" });
    await expect(fs.stat(requestPath)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const replaced = await issue();
    const current = await issue();
    await expect(
      store.redeemRecovery({
        recoveryToken: replaced.token,
        passphrase: PASSPHRASE,
      }),
    ).rejects.toMatchObject({ code: "invalid_recovery_credential" });

    // A request file readable by others is ignored, not trusted.
    await fs.chmod(requestPath, 0o644);
    await expect(
      store.redeemRecovery({
        recoveryToken: current.token,
        passphrase: PASSPHRASE,
      }),
    ).rejects.toMatchObject({ code: "invalid_recovery_credential" });
    await fs.chmod(requestPath, 0o600);

    // Two concurrent redemptions of one code: exactly one succeeds.
    const results = await Promise.allSettled([
      store.redeemRecovery({
        recoveryToken: current.token,
        passphrase: PASSPHRASE,
      }),
      store.redeemRecovery({
        recoveryToken: current.token,
        passphrase: PASSPHRASE,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
  });

  it("refuses local recovery before an owner exists or on corrupt state", async () => {
    const clock = { value: Date.now() };
    const { store, root } = await openStore(clock);
    await expect(
      issueLocalRecoveryCredential({ dataRoot: root }),
    ).rejects.toMatchObject({ code: "owner_missing" });
    await expect(
      issueLocalRecoveryCredential({ dataRoot: path.join(root, "missing") }),
    ).rejects.toMatchObject({ code: "owner_missing" });
    await store.close();
    await fs.writeFile(path.join(root, "access-state.json"), "{not json");
    await expect(
      issueLocalRecoveryCredential({ dataRoot: root }),
    ).rejects.toMatchObject({ code: "access_state_corrupt" });
  });

  it("binds CSRF tokens to one session token", () => {
    const first = "a".repeat(43);
    const second = "b".repeat(43);
    expect(verifyCsrfToken(first, csrfTokenForSession(first))).toBe(true);
    expect(verifyCsrfToken(first, csrfTokenForSession(second))).toBe(false);
    expect(verifyCsrfToken(first, undefined)).toBe(false);
  });
});

/** Keep a session active daily until it passes the 30-day absolute limit. */
async function bootstrappedSessionKeptAlive(clock: { value: number }) {
  const { store, issued } = await bootstrapped(clock);
  for (let day = 0; day < 30; day += 1) {
    clock.value += DAY;
    await store.authenticate(issued.token);
  }
  return { store, token: issued.token };
}
