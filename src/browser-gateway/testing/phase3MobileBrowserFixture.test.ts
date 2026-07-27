/** @vitest-environment node */

import * as fs from "fs/promises";
import * as http from "http";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { PHASE3_MOBILE_PAINT_CATEGORIES } from "./phase3MobilePaintGate.js";
import { Phase3MobileBrowserFixture } from "./phase3MobileBrowserFixture.js";

const fixtures: Phase3MobileBrowserFixture[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.stop()));
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("Phase3MobileBrowserFixture", () => {
  it("runs the production helper/runtime relay path for all mobile paint categories", async () => {
    const homeRootPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-phase3-mobile-home-"),
    );
    temporaryRoots.push(homeRootPath);
    const [helperPort, metadataPort] = await distinctAvailablePorts();
    const fixture = new Phase3MobileBrowserFixture({
      helperPort,
      metadataPort,
      homeRootPath,
      extensionRootPath: process.cwd(),
      dataPlaneMode: "on",
    });
    fixtures.push(fixture);

    await fixture.start();

    const healthResponse = await fetch(`${fixture.baseUrl}/health`);
    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toMatchObject({
      status: "ok",
      helperGenerationId: fixture.identity.helperGenerationId,
      dataPlaneMode: "on",
    });

    const rootResponse = await fetch(`${fixture.baseUrl}/`);
    expect(rootResponse.status).toBe(200);
    expect(await rootResponse.text()).toContain(
      "window.__AGENTLINK_BROWSER_GATEWAY__",
    );

    const instancesResponse = await fetch(`${fixture.baseUrl}/api/instances`, {
      headers: {
        Cookie: rootResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "",
      },
    });
    expect(instancesResponse.status).toBe(200);
    await expect(instancesResponse.json()).resolves.toMatchObject({
      currentInstanceId: fixture.identity.instanceId,
      dataPlaneMode: "on",
      instances: [
        expect.objectContaining({
          instanceId: fixture.identity.instanceId,
          workspaceName: fixture.identity.workspaceName,
          status: expect.objectContaining({ kind: "working" }),
        }),
      ],
    });

    const results = [];
    for (const category of PHASE3_MOBILE_PAINT_CATEGORIES) {
      results.push(await fixture.trigger(category));
    }

    expect(results.map((result) => result.eventKind)).toEqual([
      "transcript.block.delta",
      "foreground.control.updated",
      "interaction.updated",
      "interaction.updated",
      "transcript.message.upserted",
      "transcript.message.upserted",
    ]);
    const firstOwnerSequence = results[0]!.ownerSequence;
    expect(results.map((result) => result.ownerSequence)).toEqual(
      results.map((_, index) => firstOwnerSequence + index),
    );
    expect(new Set(results.map((result) => result.eventId)).size).toBe(
      results.length,
    );

    // Exercise evaluator authentication, payload validation, and category
    // accounting. The separate Chrome fixture run supplies real post-paint
    // measurements and is the authoritative latency gate.
    const evaluatorResponse = await fetch(
      `${fixture.metadataBaseUrl}/__phase3/evaluate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fixture.metadataAuthToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          minimumSamplesPerClass: 1,
          samples: results.map((result, index) => ({
            correlationId: `correlation-${index}`,
            eventId: result.eventId,
            ownerId: fixture.identity.ownerId,
            ownerGenerationId: fixture.identity.ownerGenerationId,
            ownerSequence: result.ownerSequence,
            eventKind: result.eventKind,
            category: result.category,
            latencyClass:
              result.category === "text" || result.category === "progress"
                ? "text_progress"
                : "immediate",
            sourceEventAt: index,
            paintedAt: index + 1,
            elapsedMs: 1,
          })),
        }),
      },
    );
    expect(evaluatorResponse.status).toBe(200);
    await expect(evaluatorResponse.json()).resolves.toMatchObject({
      passed: true,
      violations: [],
      categoryCounts: Object.fromEntries(
        PHASE3_MOBILE_PAINT_CATEGORIES.map((category) => [category, 1]),
      ),
    });

    expect(await fixture.listRegistryInstances()).toEqual([
      expect.objectContaining({
        instanceId: fixture.identity.instanceId,
        dataPlaneMode: "on",
        url: fixture.metadataBaseUrl,
      }),
    ]);

    await fixture.stop();
    expect(await fixture.listRegistryInstances()).toEqual([]);
  }, 15_000);
});

async function distinctAvailablePorts(): Promise<[number, number]> {
  const first = await availablePort();
  let second = await availablePort();
  while (second === first) second = await availablePort();
  return [first, second];
}

async function availablePort(): Promise<number> {
  const server = http.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("phase3_mobile_test_port_missing"));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
