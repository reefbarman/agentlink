import { expect, it, vi } from "vitest";

import { refreshDesktopOwner } from "./desktopOwnerRouting.js";

it("refreshes without an open renderer and notifies after success", async () => {
  const refresh = vi.fn(async () => undefined);
  const notify = vi.fn();

  await refreshDesktopOwner({
    ownerId: " agentlink-desktop~generation ",
    refresh,
    notify,
    log: vi.fn(),
    retryDelayMs: 0,
  });

  expect(refresh).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenNthCalledWith(1, "agentlink-desktop~generation");
  expect(notify).toHaveBeenNthCalledWith(2, "agentlink-desktop~generation");
});

it("notifies immediately and retries a transient refresh failure", async () => {
  const refresh = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("helper unavailable"))
    .mockResolvedValue(undefined);
  const notify = vi.fn();
  const log = vi.fn();

  await refreshDesktopOwner({
    ownerId: "agentlink-desktop~updated",
    refresh,
    notify,
    log,
    retryDelayMs: 0,
  });

  expect(refresh).toHaveBeenCalledTimes(2);
  expect(notify).toHaveBeenNthCalledWith(1, "agentlink-desktop~updated");
  expect(notify).toHaveBeenNthCalledWith(2, "agentlink-desktop~updated");
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining(
      "owner-change credential refresh failed (attempt 1/3)",
    ),
  );
});
