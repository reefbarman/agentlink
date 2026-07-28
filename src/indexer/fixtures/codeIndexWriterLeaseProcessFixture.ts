import {
  CODE_INDEX_WRITER_FENCED_ERROR,
  acquireCodeIndexWriterLease,
  withCodeIndexWriterFence,
} from "../codeIndexWriterLease.js";

interface StartMessage {
  type: "start";
  storeRoot: string;
  workspaceScopeId: string;
  ownerId: string;
  staleMs: number;
}

interface MutateMessage {
  type: "mutate";
  value: string;
}

let lease: Awaited<ReturnType<typeof acquireCodeIndexWriterLease>> | undefined;

process.on("message", (message: StartMessage | MutateMessage) => {
  void handle(message).catch((error) => {
    send({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  });
});

async function handle(message: StartMessage | MutateMessage): Promise<void> {
  if (message.type === "start") {
    lease = await acquireCodeIndexWriterLease({
      storeRoot: message.storeRoot,
      workspaceScopeId: message.workspaceScopeId,
      ownerId: message.ownerId,
      protocolVersion: "v4-test",
      options: { staleMs: message.staleMs },
    });
    send({ type: "acquired", fenceToken: lease.fenceToken });
    return;
  }

  if (!lease) throw new Error("lease_not_acquired");
  try {
    const result = await withCodeIndexWriterFence(
      lease,
      async () => message.value,
    );
    send({ type: "mutated", value: result, fenceToken: lease.fenceToken });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    send({
      type: text === CODE_INDEX_WRITER_FENCED_ERROR ? "fenced" : "error",
      message: text,
      fenceToken: lease.fenceToken,
    });
  }
}

function send(message: Record<string, unknown>): void {
  process.send?.(message);
}
