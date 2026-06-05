/** @vitest-environment node */

import { afterEach, describe, expect, it, vi } from "vitest";

import { EventEmitter } from "events";

const mocks = vi.hoisted(() => ({
  mdnsInstances: [] as FakeMdns[],
  makeMdns: vi.fn((_options?: unknown) => {
    const mdns = new FakeMdns();
    mocks.mdnsInstances.push(mdns);
    setTimeout(() => mdns.emit("ready"), 0);
    return mdns;
  }),
}));

class FakeMdns extends EventEmitter {
  query = vi.fn(() => {
    queueMicrotask(() => {
      this.emit("error", new Error("bind EADDRINUSE"));
      this.emit("response", {
        answers: [{ name: "agentlink.local", type: "A", data: "192.0.2.1" }],
      });
    });
  });

  respond = vi.fn();

  destroy(callback: () => void): void {
    callback();
  }
}

vi.mock("os", () => ({
  default: {
    networkInterfaces: () => ({}),
    platform: () => "linux",
  },
  networkInterfaces: () => ({}),
  platform: () => "linux",
}));

vi.mock("multicast-dns", () => ({
  default: mocks.makeMdns,
}));

describe("MdnsAdvertiser", () => {
  afterEach(() => {
    mocks.mdnsInstances.length = 0;
    mocks.makeMdns.mockClear();
  });

  it("rejects instead of crashing when a bind error arrives after ready", async () => {
    const { MdnsAdvertiser } = await import("./mdnsAdvertiser.js");
    const log = vi.fn();
    const advertiser = new MdnsAdvertiser({
      desiredName: "agentlink",
      port: 47137,
      log,
    });

    const startPromise = advertiser.start();

    await expect(startPromise).rejects.toThrow(/mdns_bind_failed/);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("bind EADDRINUSE"),
    );
  });

  it("uses the default multicast-dns socket instead of per-interface binds", async () => {
    const { MdnsAdvertiser } = await import("./mdnsAdvertiser.js");
    const advertiser = new MdnsAdvertiser({
      desiredName: "agentlink",
      port: 47137,
    });

    await expect(advertiser.start()).rejects.toThrow(/mdns_bind_failed/);

    expect(mocks.makeMdns).toHaveBeenCalledTimes(1);
    expect(mocks.makeMdns).toHaveBeenCalledWith();
  });
});
