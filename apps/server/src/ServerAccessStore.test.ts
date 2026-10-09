import {
  MAX_FAILED_PAIRING_ATTEMPTS,
  ServerAccessStore,
  issueLocalPairingCode,
} from "./ServerAccessStore.js";
import { afterEach, describe, expect, it } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

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
  });
  return { store, root };
}

/** A store with one device signed in through a pairing code. */
async function paired(clock: { value: number }) {
  const { store, root } = await openStore(clock);
  const { code } = store.createPairing();
  const issued = await store.redeemPairing({ code, deviceLabel: "Laptop" });
  return { store, root, issued };
}

describe("server access store", () => {
  it("creates the owner on first open and keeps it across restarts", async () => {
    const clock = { value: Date.now() };
    const { store, root } = await openStore(clock);
    const ownerId = store.ownerId;
    expect(store.hasActiveDevices).toBe(false);
    await store.close();
    const reopened = await openStore(clock, root);
    expect(reopened.store.ownerId).toBe(ownerId);
    await reopened.store.close();
  });

  it("migrates passphrase-era state, dropping secrets but keeping devices", async () => {
    const clock = { value: Date.now() };
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "access-store-"));
    roots.push(root);
    const { store } = await openStore(clock, root);
    const { code } = store.createPairing();
    const issued = await store.redeemPairing({ code });
    const ownerId = store.ownerId;
    await store.close();

    // Rewrite the file in the old shape: passphrase, setup, authenticatedAt.
    const file = path.join(root, "access-state.json");
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    state.owner.passphrase = { hash: "old", salt: "old" };
    state.setup = { tokenHash: "old", expiresAt: 1 };
    state.sessions[0].authenticatedAt = clock.value;
    state.sessions.push({ ...state.sessions[0], revokedAt: clock.value });
    await fs.writeFile(file, JSON.stringify(state));

    const migrated = await openStore(clock, root);
    expect(migrated.store.ownerId).toBe(ownerId);
    await expect(
      migrated.store.authenticate(issued.token),
    ).resolves.toMatchObject({ ok: true });
    const written = await fs.readFile(file, "utf8");
    expect(written).not.toContain("passphrase");
    expect(written).not.toContain("setup");
    expect(written).not.toContain("authenticatedAt");
    expect(JSON.parse(written).sessions).toHaveLength(1);
    await migrated.store.close();
  });

  it("fails closed on a corrupt state file instead of starting fresh", async () => {
    const clock = { value: Date.now() };
    const { store, root } = await paired(clock);
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

  it("redeems a pairing code once, then it is gone", async () => {
    const clock = { value: Date.now() };
    const { store, issued } = await paired(clock);
    expect(issued.session.deviceLabel).toBe("Laptop");
    expect(store.hasActiveDevices).toBe(true);
    await expect(store.authenticate(issued.token)).resolves.toMatchObject({
      ok: true,
    });

    const { code } = store.createPairing();
    // Spaces and dashes are accepted, as typed from "123 456".
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    const results = await Promise.allSettled([
      store.redeemPairing({ code: spaced }),
      store.redeemPairing({ code }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    await expect(store.redeemPairing({ code })).rejects.toMatchObject({
      code: "invalid_pairing_code",
    });
  });

  it("expires pairing codes and limits how many are outstanding", async () => {
    const clock = { value: Date.now() };
    const { store } = await openStore(clock);
    const { code } = store.createPairing();
    clock.value += 5 * 60 * 1000;
    await expect(store.redeemPairing({ code })).rejects.toMatchObject({
      code: "invalid_pairing_code",
    });
    for (let index = 0; index < 5; index += 1) store.createPairing();
    expect(() => store.createPairing()).toThrow(
      expect.objectContaining({ code: "pairing_limit_reached" }),
    );
  });

  it("withdraws every code after too many wrong guesses", async () => {
    const clock = { value: Date.now() };
    const { store, root } = await openStore(clock);
    const { code } = store.createPairing();
    const local = await issueLocalPairingCode({
      dataRoot: root,
      now: () => clock.value,
    });
    const wrong = code === "000000" ? "000001" : "000000";
    for (let index = 0; index < MAX_FAILED_PAIRING_ATTEMPTS; index += 1) {
      await expect(store.redeemPairing({ code: wrong })).rejects.toMatchObject({
        code: "invalid_pairing_code",
      });
    }
    await expect(store.redeemPairing({ code })).rejects.toMatchObject({
      code: "invalid_pairing_code",
    });
    await expect(
      store.redeemPairing({ code: local.code }),
    ).rejects.toMatchObject({ code: "invalid_pairing_code" });
  });

  it.skipIf(process.getuid?.() === 0)(
    "keeps every code blocked until the local code can be withdrawn",
    async () => {
      const clock = { value: Date.now() };
      const { store, root } = await openStore(clock);
      const local = await issueLocalPairingCode({
        dataRoot: root,
        now: () => clock.value,
      });
      const wrong = local.code === "000000" ? "000001" : "000000";
      // A read-only directory makes removing the local code fail.
      await fs.chmod(root, 0o500);
      try {
        for (let index = 1; index < MAX_FAILED_PAIRING_ATTEMPTS; index += 1) {
          await expect(
            store.redeemPairing({ code: wrong }),
          ).rejects.toMatchObject({ code: "invalid_pairing_code" });
        }
        await expect(store.redeemPairing({ code: wrong })).rejects.toThrow();
        // Even the right code is refused while the withdrawal is unfinished.
        await expect(
          store.redeemPairing({ code: local.code }),
        ).rejects.toThrow();
      } finally {
        await fs.chmod(root, 0o700);
      }
      await expect(
        store.redeemPairing({ code: local.code }),
      ).rejects.toMatchObject({ code: "invalid_pairing_code" });
      await expect(
        fs.stat(path.join(root, "local-pairing.json")),
      ).rejects.toThrow();
    },
  );

  it("rejects malformed device labels", async () => {
    const clock = { value: Date.now() };
    const { store } = await openStore(clock);
    const { code } = store.createPairing();
    await expect(
      store.redeemPairing({ code, deviceLabel: "bad\nlabel" }),
    ).rejects.toMatchObject({ code: "invalid_label" });
  });

  it("applies idle and absolute session expiry", async () => {
    const clock = { value: Date.now() };
    const { store, issued } = await paired(clock);
    clock.value += 6 * DAY;
    await expect(store.authenticate(issued.token)).resolves.toMatchObject({
      ok: true,
    });
    clock.value += 7 * DAY;
    await expect(store.authenticate(issued.token)).resolves.toEqual({
      ok: false,
      reason: "expired",
    });

    const second = await paired(clock);
    for (let day = 0; day < 30; day += 1) {
      clock.value += DAY;
      await second.store.authenticate(second.issued.token);
    }
    await expect(
      second.store.authenticate(second.issued.token),
    ).resolves.toEqual({ ok: false, reason: "expired" });
  });

  it("revokes a device and every session it holds", async () => {
    const clock = { value: Date.now() };
    const { store, issued } = await paired(clock);
    const revoked: string[] = [];
    store.onSessionsRevoked((ids) => revoked.push(...ids));
    await expect(store.revokeDevice(issued.session.deviceId)).resolves.toBe(
      true,
    );
    expect(revoked).toEqual([issued.session.sessionId]);
    expect(store.hasActiveDevices).toBe(false);
    await expect(store.authenticate(issued.token)).resolves.toMatchObject({
      ok: false,
    });
    await expect(store.revokeDevice(issued.session.deviceId)).resolves.toBe(
      false,
    );
  });

  it("lets only one store own a data root and replaces stale locks", async () => {
    const clock = { value: Date.now() };
    const { store, root } = await paired(clock);
    await expect(openStore(clock, root)).rejects.toMatchObject({
      code: "access_state_locked",
    });
    await store.close();
    await expect(store.revokeSession("anything")).resolves.toBe(false);
    const reopened = await openStore(clock, root);
    expect(reopened.store.hasActiveDevices).toBe(true);
    await reopened.store.close();

    // A lock left by a process that no longer exists does not block startup.
    await fs.writeFile(
      path.join(root, "access-state.lock"),
      JSON.stringify({ pid: 2 ** 22 + 12_345, token: "stale" }),
    );
    const recovered = await openStore(clock, root);
    expect(recovered.store.hasActiveDevices).toBe(true);
    await recovered.store.close();
    await expect(
      fs.stat(path.join(root, "access-state.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pairs from a local code while the server holds the lock", async () => {
    const clock = { value: Date.now() };
    const { store, root } = await openStore(clock);
    const { code } = await issueLocalPairingCode({
      dataRoot: root,
      now: () => clock.value,
    });
    expect(code).toMatch(/^[0-9]{6}$/u);
    const requestPath = path.join(root, "local-pairing.json");
    expect((await fs.stat(requestPath)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(requestPath, "utf8")).not.toContain(code);

    const issued = await store.redeemPairing({ code, deviceLabel: "Phone" });
    await expect(store.authenticate(issued.token)).resolves.toMatchObject({
      ok: true,
    });
    await expect(fs.stat(requestPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(store.redeemPairing({ code })).rejects.toMatchObject({
      code: "invalid_pairing_code",
    });
  });

  it("expires, replaces, and ignores tampered local codes", async () => {
    const clock = { value: Date.now() };
    const { store, root } = await openStore(clock);
    const issue = () =>
      issueLocalPairingCode({ dataRoot: root, now: () => clock.value });
    const requestPath = path.join(root, "local-pairing.json");

    const expired = await issue();
    clock.value += 10 * 60 * 1000;
    await expect(
      store.redeemPairing({ code: expired.code }),
    ).rejects.toMatchObject({ code: "invalid_pairing_code" });

    const replaced = await issue();
    const current = await issue();
    if (replaced.code !== current.code) {
      await expect(
        store.redeemPairing({ code: replaced.code }),
      ).rejects.toMatchObject({ code: "invalid_pairing_code" });
    }

    // A request file readable by others is ignored, not trusted.
    await fs.chmod(requestPath, 0o644);
    await expect(
      store.redeemPairing({ code: current.code }),
    ).rejects.toMatchObject({ code: "invalid_pairing_code" });
    await fs.chmod(requestPath, 0o600);
    await expect(
      store.redeemPairing({ code: current.code }),
    ).resolves.toMatchObject({ session: { deviceLabel: "Browser" } });
  });
});
