import { BACKUP_PROTOCOL } from "./backupAgent.js";
import { createBackupClient } from "./backupClient.js";
import { pingCommandWorker } from "./commandWorkerClient.js";
import { COMMAND_WORKER_PROTOCOL } from "./commandWorkerProtocol.js";
import { PUBLISHER_PROTOCOL } from "./publisher.js";
import { createPublisherClient } from "./publisherClient.js";
import { createRunnerManagerClient } from "./runnerManager.js";
import { RUNNER_PROTOCOL } from "./runnerProtocol.js";
import { parseBuild, type ServiceVersion } from "./serverBuild.js";
import { prepareSecret, type AssistantServerConfig } from "./serverConfig.js";

/**
 * Ask every internal service this configuration uses for its build and
 * protocol: the command worker, the publisher, the runner manager, and the
 * backup sidecar. The egress gateway runs the assistant's own image and has
 * no authenticated ping, so it is not asked.
 */
export async function serviceVersions(
  config: AssistantServerConfig,
  env: NodeJS.ProcessEnv,
  timeoutMs = 3_000,
): Promise<ServiceVersion[]> {
  const asked: Array<Promise<ServiceVersion>> = [];
  const failed = (name: string, error: unknown): ServiceVersion => ({
    name,
    reachable: false,
    error: error instanceof Error ? error.message : String(error),
  });

  if (config.commandWorker) {
    const worker = config.commandWorker;
    asked.push(
      (async (): Promise<ServiceVersion> => {
        const ping = await pingCommandWorker({
          host: worker.host,
          port: worker.port,
          readToken: await prepareSecret(
            worker.token,
            "commandWorker.token",
            env,
          ),
          connectTimeoutMs: timeoutMs,
        });
        if (!ping.ok) {
          return {
            name: "command worker",
            reachable: false,
            // The worker refuses a ping in another protocol outright.
            error:
              ping.code === "protocol_unsupported"
                ? `it speaks another protocol than the assistant (${COMMAND_WORKER_PROTOCOL}): rebuild both`
                : ping.code,
          };
        }
        return {
          name: "command worker",
          reachable: true,
          protocol: ping.protocol,
          expectedProtocol: COMMAND_WORKER_PROTOCOL,
          ...(ping.build ? { build: ping.build } : {}),
        };
      })().catch((error: unknown) => failed("command worker", error)),
    );
  }
  if (config.publisher) {
    const publisher = config.publisher;
    asked.push(
      (async (): Promise<ServiceVersion> => {
        const client = createPublisherClient({
          host: publisher.host,
          port: publisher.port,
          token: await prepareSecret(publisher.token, "publisher.token", env),
          timeoutMs,
        });
        const health = await client.health();
        const build = parseBuild(health.build);
        return {
          name: "publisher",
          reachable: true,
          protocol: health.protocol,
          expectedProtocol: PUBLISHER_PROTOCOL,
          ...(build ? { build } : {}),
        };
      })().catch((error: unknown) => failed("publisher", error)),
    );
  }
  if (config.runners) {
    const manager = config.runners.manager;
    asked.push(
      (async (): Promise<ServiceVersion> => {
        const client = createRunnerManagerClient({
          host: manager.host,
          port: manager.port,
          readToken: await prepareSecret(
            manager.token,
            "runners.manager.token",
            env,
          ),
        });
        const health = await withTimeout(client.ping(), timeoutMs);
        const build = parseBuild(health.build);
        return {
          name: "runner manager",
          reachable: true,
          // Managers from before versions were reported send no protocol.
          protocol:
            typeof health.protocol === "number" ? health.protocol : undefined,
          expectedProtocol: RUNNER_PROTOCOL,
          ...(build ? { build } : {}),
        };
      })().catch((error: unknown) => failed("runner manager", error)),
    );
  }
  if (config.backup) {
    const backup = config.backup;
    asked.push(
      (async (): Promise<ServiceVersion> => {
        const client = createBackupClient({
          host: backup.host,
          port: backup.port,
          token: await prepareSecret(backup.token, "backup.token", env),
        });
        const health = await withTimeout(client.health(), timeoutMs);
        const build = parseBuild(health.build);
        return {
          name: "backup sidecar",
          reachable: true,
          protocol: health.protocol,
          expectedProtocol: BACKUP_PROTOCOL,
          ...(build ? { build } : {}),
        };
      })().catch((error: unknown) => failed("backup sidecar", error)),
    );
  }
  return await Promise.all(asked);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
