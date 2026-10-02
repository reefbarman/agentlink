import { describe, expect, it, vi } from "vitest";

import { StandaloneMcpManagerOperations } from "./StandaloneMcpManagerOperations.js";

describe("StandaloneMcpManagerOperations", () => {
  it("authorizes sign-in directly only for the matching server and owner signal", async () => {
    let ownerSignal: AbortSignal | undefined;
    const connect = vi.fn(async (_server, signal: AbortSignal) => {
      ownerSignal = signal;
      expect(await operations.authorize({ serverName: "other", signal })).toBe(
        false,
      );
      expect(
        await operations.authorize({
          serverName: "remote",
          signal: new AbortController().signal,
        }),
      ).toBe(false);
      expect(await operations.authorize({ serverName: "remote", signal })).toBe(
        true,
      );
      expect(operations.get("operation-one")?.approval).toBeNull();
    });
    const operations = new StandaloneMcpManagerOperations({
      canStart: () => true,
      connect,
      reauthenticate: vi.fn(),
      onSettled: vi.fn(),
    });
    expect(
      await operations.authorize({ serverName: "remote", signal: undefined }),
    ).toBe(false);
    operations.start("operation-one", "remote", "connect");
    await vi.waitFor(() =>
      expect(operations.get("operation-one")?.status).toBe("completed"),
    );
    expect(ownerSignal).toBeDefined();
    expect(connect).toHaveBeenCalledWith("remote", ownerSignal, false);
    expect(operations.respond("operation-one", "old-approval", true)).toBe(
      false,
    );
    expect(
      await operations.authorize({ serverName: "remote", signal: ownerSignal }),
    ).toBe(false);
  });

  it("cancels browser sign-in and blocks new work until cleanup finishes", async () => {
    let finish!: () => void;
    let signal!: AbortSignal;
    const cleanup = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const operations = new StandaloneMcpManagerOperations({
      canStart: () => true,
      connect: async (_server, ownerSignal) => {
        signal = ownerSignal;
        expect(
          await operations.authorize({ serverName: "remote", signal }),
        ).toBe(true);
        await cleanup;
      },
      reauthenticate: vi.fn(),
      onSettled: vi.fn(),
    });
    operations.start("operation-one", "remote", "reconnect");
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(operations.get("operation-one")?.approval).toBeNull();
    expect(operations.cancel("other-operation")).toBe(false);
    expect(operations.cancel("operation-one")).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(operations.get("operation-one")?.status).toBe("cancelled");
    expect(await operations.authorize({ serverName: "remote", signal })).toBe(
      false,
    );
    expect(operations.respond("operation-one", "old-approval", true)).toBe(
      false,
    );
    expect(() =>
      operations.start("operation-two", "remote", "connect"),
    ).toThrow("desktop_mcp_busy");
    finish();
    await vi.waitFor(() => expect(operations.isRunning()).toBe(false));
  });

  it("uses the explicit reauthenticate action without a second confirmation", async () => {
    const reauthenticate = vi.fn(
      async (
        _server,
        confirm: (origin: string) => Promise<boolean>,
        signal: AbortSignal,
      ) => {
        expect(signal.aborted).toBe(false);
        expect(await confirm("https://auth.example.com")).toBe(true);
        expect(operations.get("operation-one")?.approval).toBeNull();
        operations.cancel("operation-one");
        expect(await confirm("https://auth.example.com")).toBe(false);
      },
    );
    const connect = vi.fn();
    const operations = new StandaloneMcpManagerOperations({
      canStart: () => true,
      connect,
      reauthenticate,
      onSettled: vi.fn(),
    });
    operations.start("operation-one", "remote");
    await vi.waitFor(() => expect(operations.isRunning()).toBe(false));
    expect(operations.get("operation-one")).toMatchObject({
      mode: "reauthenticate",
      status: "cancelled",
      approval: null,
    });
    expect(connect).not.toHaveBeenCalled();
    expect(reauthenticate).toHaveBeenCalledOnce();
  });

  it("rejects a late start when the window-close cancellation arrives first", () => {
    const connect = vi.fn();
    const operations = new StandaloneMcpManagerOperations({
      canStart: () => true,
      connect,
      reauthenticate: vi.fn(),
      onSettled: vi.fn(),
    });
    expect(operations.cancel("operation-one")).toBe(false);
    expect(() =>
      operations.start("operation-one", "remote", "connect"),
    ).toThrow("desktop_mcp_operation_cancelled");
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects manual work while an agent owns the runtime", () => {
    const operations = new StandaloneMcpManagerOperations({
      canStart: () => false,
      connect: vi.fn(),
      reauthenticate: vi.fn(),
      onSettled: vi.fn(),
    });
    expect(() =>
      operations.start("operation-one", "remote", "connect"),
    ).toThrow("desktop_mcp_busy");
    expect(operations.get("operation-one")).toBeUndefined();
  });
});
