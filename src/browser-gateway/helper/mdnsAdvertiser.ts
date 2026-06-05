import * as os from "os";

import makeMdns from "multicast-dns";
import { randomBytes } from "crypto";

type MulticastDNSInstance = ReturnType<typeof makeMdns>;

function waitForReady(
  mdns: MulticastDNSInstance,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      mdns.removeListener("ready", onReady);
      mdns.removeListener("error", onError);
      clearTimeout(timer);
    };
    const onReady = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("mdns_bind_timeout"));
    }, timeoutMs);
    mdns.once("ready", onReady);
    mdns.once("error", onError);
  });
}
type MdnsAnswer = {
  name?: string;
  type?: string;
  data?: unknown;
};
type MdnsPacket = {
  answers?: MdnsAnswer[];
  questions?: Array<{ name?: string; type?: string }>;
};
type MdnsRemoteInfo = {
  address?: string;
  host?: string;
  port: number;
};
type MdnsTransport = {
  mdns: MulticastDNSInstance;
  iface?: string;
};

function formatTransportLabel(transport: MdnsTransport): string {
  return transport.iface ? ` on ${transport.iface}` : "";
}

export interface MdnsAdvertiserOptions {
  /** Desired hostname (without ".local"), e.g. "agentlink". */
  desiredName: string;
  /** Port the gateway listens on — included in SRV record for service discovery. */
  port: number;
  /** Called when mDNS errors occur (e.g. conflict detection, bind failure). */
  log?: (message: string) => void;
}

export interface MdnsAdvertiserState {
  hostName: string;
  fqdn: string;
  urls: string[];
}

function sanitizeDesiredName(raw: string): string {
  const trimmed = raw
    .trim()
    .toLowerCase()
    .replace(/\.local\.?$/i, "");
  const cleaned = trimmed.replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-");
  const compact = cleaned.replace(/^-+|-+$/g, "");
  return compact.length > 0 ? compact : "agentlink";
}

function listLanIpv4Addresses(): string[] {
  const addrs: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const entry of list) {
      if (entry.family !== "IPv4") continue;
      if (entry.internal) continue;
      addrs.push(entry.address);
    }
  }
  return addrs;
}

function listLanIpv6Addresses(): string[] {
  const addrs: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const entry of list) {
      if (entry.family !== "IPv6") continue;
      if (entry.internal) continue;
      if (entry.address.toLowerCase().startsWith("fe80")) continue;
      addrs.push(entry.address);
    }
  }
  return addrs;
}

/**
 * Advertises a custom `<name>.local` hostname on the LAN using mDNS.
 *
 * - Responds to A / AAAA / ANY queries for the fqdn with all non-loopback IPs.
 * - Probes for conflicting answers before committing to a name; on conflict,
 *   rotates to `<name>-<4hex>` and retries.
 */
export class MdnsAdvertiser {
  private readonly desiredName: string;
  private readonly port: number;
  private readonly log: (message: string) => void;

  private transports: MdnsTransport[] = [];
  private hostName: string | null = null;
  private fqdn: string | null = null;
  private stopped = false;
  private lastConflictLogAt = 0;
  private periodicTimer: NodeJS.Timeout | undefined;

  constructor(options: MdnsAdvertiserOptions) {
    this.desiredName = sanitizeDesiredName(options.desiredName);
    this.port = options.port;
    this.log = options.log ?? (() => undefined);
  }

  async start(): Promise<MdnsAdvertiserState> {
    if (this.transports.length > 0) {
      throw new Error("mdns_advertiser_already_started");
    }
    this.stopped = false;

    let attemptName = this.desiredName;
    for (let attempt = 0; attempt < 5 && !this.stopped; attempt++) {
      const fqdn = `${attemptName}.local`;
      const transports = await this.createTransports();
      let startupError: unknown = null;
      for (const transport of transports) {
        transport.mdns.on("error", (err: unknown) => {
          // Until these transports are promoted to this.transports, any error
          // is part of startup and should trigger the caller's IP-only fallback.
          if (this.transports !== transports) {
            startupError = err;
          }
          this.log(
            `[mdns] transport error${formatTransportLabel(transport)}: ${String(err)}`,
          );
        });
      }

      try {
        await Promise.all(
          transports.map((transport) => waitForReady(transport.mdns, 2_000)),
        );
      } catch (err) {
        await this.destroyTransports(transports);
        throw new Error(`mdns_bind_failed: ${String(err)}`);
      }

      const conflictDetected = await this.probeForConflict(transports, fqdn);
      if (startupError) {
        await this.destroyTransports(transports);
        throw new Error(`mdns_bind_failed: ${String(startupError)}`);
      }
      if (conflictDetected) {
        this.log(
          `[mdns] name ${fqdn} is already in use on the network — rotating suffix`,
        );
        await this.destroyTransports(transports);
        attemptName = `${this.desiredName}-${randomBytes(2).toString("hex")}`;
        continue;
      }

      this.transports = transports;
      this.hostName = attemptName;
      this.fqdn = fqdn;
      for (const transport of this.transports) {
        transport.mdns.on("query", (query, rinfo) =>
          this.handleQuery(
            query as MdnsPacket,
            rinfo as MdnsRemoteInfo | undefined,
          ),
        );
        transport.mdns.on("response", (response) =>
          this.handleResponse(response as MdnsPacket),
        );
      }

      this.announceAll();
      this.log(
        `[mdns] advertising ${fqdn} → ${listLanIpv4Addresses().join(", ") || "(no LAN IPv4)"} on port ${this.port}`,
      );
      this.periodicTimer = setInterval(() => {
        if (this.stopped) return;
        this.announceAll();
      }, 60_000);

      return {
        hostName: attemptName,
        fqdn,
        urls: this.buildUrls(fqdn),
      };
    }

    throw new Error("mdns_advertiser_name_conflict");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = undefined;
    }
    if (this.transports.length === 0) return;

    try {
      this.sendRecords(0);
    } catch {
      // ignore — interface may already be gone
    }
    await this.destroyTransports(this.transports);
    this.transports = [];
    this.hostName = null;
    this.fqdn = null;
  }

  getState(): MdnsAdvertiserState | null {
    if (!this.hostName || !this.fqdn) return null;
    return {
      hostName: this.hostName,
      fqdn: this.fqdn,
      urls: this.buildUrls(this.fqdn),
    };
  }

  private buildUrls(fqdn: string): string[] {
    return [`http://${fqdn}:${this.port}`];
  }

  private async createTransports(): Promise<MdnsTransport[]> {
    return [{ mdns: makeMdns() }];
  }

  private async destroyTransports(transports: MdnsTransport[]): Promise<void> {
    await Promise.all(
      transports.map(
        (transport) =>
          new Promise<void>((resolve) =>
            transport.mdns.destroy(() => resolve()),
          ),
      ),
    );
  }

  private async probeForConflict(
    transports: MdnsTransport[],
    fqdn: string,
  ): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const ourIps = new Set([
        ...listLanIpv4Addresses(),
        ...listLanIpv6Addresses(),
      ]);
      const lower = fqdn.toLowerCase();
      let done = false;

      const onResponse = (packet: MdnsPacket) => {
        if (done) return;
        for (const answer of packet.answers ?? []) {
          if (answer.name?.toLowerCase() !== lower) continue;
          if (answer.type !== "A" && answer.type !== "AAAA") continue;
          const value = String(answer.data ?? "");
          if (!value) continue;
          if (ourIps.has(value)) continue;
          done = true;
          cleanup();
          resolve(true);
          return;
        }
      };
      const cleanup = () => {
        for (const transport of transports) {
          transport.mdns.removeListener("response", onResponse);
        }
        clearTimeout(timer);
      };
      for (const transport of transports) {
        transport.mdns.on("response", onResponse as (packet: unknown) => void);
      }

      for (const transport of transports) {
        try {
          transport.mdns.query({
            questions: [
              { name: fqdn, type: "A" },
              { name: fqdn, type: "AAAA" },
            ],
          });
        } catch (err) {
          this.log(`[mdns] probe query failed: ${String(err)}`);
        }
      }

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        resolve(false);
      }, 750);
    });
  }

  private announceAll(): void {
    if (this.transports.length === 0 || !this.fqdn) return;
    this.sendRecords(120);
  }

  private sendRecords(ttl: number, rinfo?: MdnsRemoteInfo): void {
    if (this.transports.length === 0 || !this.fqdn) return;
    const ipv4 = listLanIpv4Addresses();
    const ipv6 = listLanIpv6Addresses();
    if (ipv4.length === 0 && ipv6.length === 0) return;

    const answers = [
      ...ipv4.map((ip) => ({
        name: this.fqdn!,
        type: "A" as const,
        ttl,
        data: ip,
      })),
      ...ipv6.map((ip) => ({
        name: this.fqdn!,
        type: "AAAA" as const,
        ttl,
        data: ip,
      })),
    ];
    for (const transport of this.transports) {
      try {
        if (rinfo) {
          transport.mdns.respond({ answers }, rinfo);
        } else {
          transport.mdns.respond({ answers });
        }
      } catch (err) {
        this.log(
          `[mdns] respond failed${formatTransportLabel(transport)}: ${String(err)}`,
        );
      }
    }
  }

  private handleQuery(query: MdnsPacket, rinfo?: MdnsRemoteInfo): void {
    if (this.transports.length === 0 || !this.fqdn) return;
    const lower = this.fqdn.toLowerCase();
    let shouldRespond = false;
    for (const q of query.questions ?? []) {
      if (!q?.name) continue;
      if (q.name.toLowerCase() !== lower) continue;
      if (q.type === "A" || q.type === "AAAA" || q.type === "ANY") {
        shouldRespond = true;
        break;
      }
    }
    if (!shouldRespond) return;
    this.sendRecords(120);
    if (rinfo?.address && rinfo.port) {
      this.sendRecords(120, rinfo);
    }
  }

  private handleResponse(response: MdnsPacket): void {
    if (!this.fqdn || this.transports.length === 0) return;
    const lower = this.fqdn.toLowerCase();
    const ourIps = new Set([
      ...listLanIpv4Addresses(),
      ...listLanIpv6Addresses(),
    ]);
    for (const answer of response.answers ?? []) {
      if (answer.name?.toLowerCase() !== lower) continue;
      if (answer.type !== "A" && answer.type !== "AAAA") continue;
      const value = String(answer.data ?? "");
      if (!value) continue;
      if (ourIps.has(value)) continue;
      const now = Date.now();
      if (now - this.lastConflictLogAt > 60_000) {
        this.log(
          `[mdns] another host is also answering ${this.fqdn} (${value}) — consider changing agentlink.browserGatewayMdnsName`,
        );
        this.lastConflictLogAt = now;
      }
    }
  }
}

export function listLanIpv4UrlsForPort(port: number): string[] {
  const urls: string[] = [];
  for (const ip of listLanIpv4Addresses()) {
    urls.push(`http://${ip}:${port}`);
  }
  return urls;
}
