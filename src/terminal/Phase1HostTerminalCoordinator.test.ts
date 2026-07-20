import { describe, expect, it, vi } from "vitest";

import {
  CUSTOM_TERMINAL_AVAILABLE_CONTEXT_KEY,
  CUSTOM_TERMINAL_SUPPORTED_CONTEXT_KEY,
  type CustomTerminalHost,
} from "./customTerminalSupport.js";
import {
  Phase1HostTerminalCoordinator,
  type HostTerminalDisposable,
  type Phase1HostTerminalRuntime,
} from "./Phase1HostTerminalCoordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function runtime(): Phase1HostTerminalRuntime & {
  dispose: ReturnType<typeof vi.fn<() => void>>;
} {
  return { dispose: vi.fn<() => void>() };
}

function harness(
  overrides: {
    host?: CustomTerminalHost;
    enabled?: boolean;
    createRuntime?: (
      generation: number,
    ) => PromiseLike<Phase1HostTerminalRuntime> | Phase1HostTerminalRuntime;
    setContext?: (
      key: string,
      value: boolean,
    ) => PromiseLike<unknown> | unknown;
    onRuntimeUnavailable?: (error: Error) => PromiseLike<void> | void;
  } = {},
) {
  let host = overrides.host ?? { platform: "darwin" };
  let enabled = overrides.enabled ?? true;
  let enabledListener: (() => void) | undefined;
  const contexts: Array<[string, boolean]> = [];
  const subscription: HostTerminalDisposable & {
    dispose: ReturnType<typeof vi.fn<() => void>>;
  } = { dispose: vi.fn<() => void>() };
  const created = runtime();
  const createRuntime = vi.fn(overrides.createRuntime ?? (() => created));
  const coordinator = new Phase1HostTerminalCoordinator({
    getHost: () => host,
    isEnabled: () => enabled,
    setContext: async (key, value) => {
      contexts.push([key, value]);
      await overrides.setContext?.(key, value);
    },
    createRuntime,
    subscribeEnabledChanges: (listener) => {
      enabledListener = listener;
      return subscription;
    },
    onRuntimeUnavailable: overrides.onRuntimeUnavailable,
  });
  return {
    coordinator,
    contexts,
    createRuntime,
    created,
    subscription,
    setEnabled(value: boolean) {
      enabled = value;
      enabledListener?.();
    },
    setHost(value: CustomTerminalHost) {
      host = value;
    },
  };
}

const supportedContext: [string, boolean] = [
  CUSTOM_TERMINAL_SUPPORTED_CONTEXT_KEY,
  true,
];
const unavailableContext: [string, boolean] = [
  CUSTOM_TERMINAL_AVAILABLE_CONTEXT_KEY,
  false,
];
const availableContext: [string, boolean] = [
  CUSTOM_TERMINAL_AVAILABLE_CONTEXT_KEY,
  true,
];

describe("Phase1HostTerminalCoordinator", () => {
  it.each([
    ["setting disabled", { platform: "darwin" }, false],
    ["unsupported OS", { platform: "linux" }, true],
    ["remote host", { platform: "darwin", remoteName: "ssh-remote" }, true],
  ])("keeps provider lifecycle cold when %s", async (_name, host, enabled) => {
    const test = harness({ host, enabled });

    await test.coordinator.start();

    expect(test.createRuntime).not.toHaveBeenCalled();
    expect(test.coordinator.isAcceptingRequests).toBe(false);
    expect(test.contexts).toContainEqual(unavailableContext);
    expect(test.contexts.at(-1)).toEqual(unavailableContext);
  });

  it("publishes support, registers once, then publishes availability", async () => {
    const test = harness();

    await test.coordinator.start();

    expect(test.createRuntime).toHaveBeenCalledTimes(1);
    expect(test.contexts).toEqual([
      supportedContext,
      unavailableContext,
      availableContext,
    ]);
    expect(test.coordinator.isAcceptingRequests).toBe(true);
  });

  it("disables requests before clearing availability and disposes once", async () => {
    const test = harness();
    await test.coordinator.start();

    test.setEnabled(false);
    expect(test.coordinator.isAcceptingRequests).toBe(false);
    await test.coordinator.whenIdle();

    expect(test.created.dispose).toHaveBeenCalledTimes(1);
    expect(test.contexts.at(-1)).toEqual(unavailableContext);
    test.coordinator.dispose();
    expect(test.created.dispose).toHaveBeenCalledTimes(1);
    expect(test.subscription.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes a stale runtime candidate without publishing it available", async () => {
    const pending = deferred<Phase1HostTerminalRuntime>();
    const stale = runtime();
    const test = harness({ createRuntime: () => pending.promise });

    test.coordinator.start();
    while (test.createRuntime.mock.calls.length === 0) {
      await Promise.resolve();
    }
    test.setEnabled(false);
    pending.resolve(stale);
    await test.coordinator.whenIdle();

    expect(stale.dispose).toHaveBeenCalledTimes(1);
    expect(test.contexts).not.toContainEqual(availableContext);
    expect(test.coordinator.isAcceptingRequests).toBe(false);
  });

  it("keeps availability false and reports runtime registration failure", async () => {
    const onRuntimeUnavailable = vi.fn();
    const test = harness({
      createRuntime: () => {
        throw new Error("registration failed");
      },
      onRuntimeUnavailable,
    });

    await test.coordinator.start();

    expect(test.contexts.at(-1)).toEqual(unavailableContext);
    expect(test.coordinator.isAcceptingRequests).toBe(false);
    expect(onRuntimeUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({ message: "registration failed" }),
    );
  });

  it("keeps availability false when runtime remediation fails", async () => {
    const test = harness({
      createRuntime: () => {
        throw new Error("registration failed");
      },
      onRuntimeUnavailable: () => {
        throw new Error("notification failed");
      },
    });

    await expect(test.coordinator.start()).resolves.toBeUndefined();
    expect(test.contexts.at(-1)).toEqual(unavailableContext);
    expect(test.coordinator.isAcceptingRequests).toBe(false);
  });

  it("cleans a runtime if availability publication fails", async () => {
    const test = harness({
      setContext: (key, value) => {
        if (key === CUSTOM_TERMINAL_AVAILABLE_CONTEXT_KEY && value) {
          throw new Error("setContext failed");
        }
      },
    });

    await test.coordinator.start();

    expect(test.created.dispose).toHaveBeenCalledTimes(1);
    expect(test.contexts.at(-1)).toEqual(unavailableContext);
    expect(test.coordinator.isAcceptingRequests).toBe(false);
  });

  it("cleans a runtime if availability publication becomes stale", async () => {
    const publishingAvailable = deferred<void>();
    const test = harness({
      setContext: (key, value) =>
        key === CUSTOM_TERMINAL_AVAILABLE_CONTEXT_KEY && value
          ? publishingAvailable.promise
          : undefined,
    });

    test.coordinator.start();
    while (
      !test.contexts.some(
        ([key, value]) =>
          key === CUSTOM_TERMINAL_AVAILABLE_CONTEXT_KEY && value,
      )
    ) {
      await Promise.resolve();
    }
    test.setEnabled(false);
    publishingAvailable.resolve();
    await test.coordinator.whenIdle();

    expect(test.created.dispose).toHaveBeenCalledTimes(1);
    expect(test.contexts.at(-1)).toEqual(unavailableContext);
    expect(test.coordinator.isAcceptingRequests).toBe(false);
  });

  it("recreates a fresh runtime after disable and re-enable", async () => {
    const runtimes = [runtime(), runtime()];
    const test = harness({ createRuntime: () => runtimes.shift()! });
    await test.coordinator.start();

    test.setEnabled(false);
    await test.coordinator.whenIdle();
    test.setEnabled(true);
    await test.coordinator.whenIdle();

    expect(test.createRuntime).toHaveBeenCalledTimes(2);
    expect(test.coordinator.isAcceptingRequests).toBe(true);
  });
});
