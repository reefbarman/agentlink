// Drives end-to-end bench attempts through a VS Code window's chat tabs.
// Pure orchestration: the gateway client, fixture reset, trace reader and
// attempt recorder are injected so the loop can be tested without VS Code.

const DONE_STATUSES = new Set(["completed", "idle", "failed"]);

/**
 * Balanced run order: within each round, every task rotates the model order
 * so no model always goes first (or last) on the same task.
 */
export function buildSchedule(models, taskIds, rounds = 2) {
  const schedule = [];
  for (let round = 0; round < rounds; round++) {
    taskIds.forEach((taskId, taskIndex) => {
      const shift = (round + taskIndex) % models.length;
      const order = [...models.slice(shift), ...models.slice(0, shift)];
      for (const model of order) {
        schedule.push({ round: round + 1, taskId, model });
      }
    });
  }
  return schedule;
}

export function findTab(state, sessionId) {
  return state?.session?.chatWorkspace?.tabs?.find(
    (tab) => tab.sessionId === sessionId,
  );
}

function focusedSelection(state) {
  const workspace = state?.session?.chatWorkspace;
  const focused = workspace?.tabs?.find(
    (tab) => tab.tabId === workspace.focusedTabId,
  );
  if (!workspace?.controllerEpoch || !focused) {
    throw new Error("VS Code has no chat tab to anchor a new tab on.");
  }
  return {
    controllerEpoch: workspace.controllerEpoch,
    tabId: focused.tabId,
    sessionId: focused.sessionId ?? null,
  };
}

export const DEFAULT_LIMITS = { maxMinutes: 10, maxRequests: 20 };

/**
 * Caps for one task: `--max-minutes` / `--max-requests` win, then the task's
 * own `limits`, then DEFAULT_LIMITS. Longer tasks declare bigger caps so a
 * campaign can mix them with short ones.
 */
export function resolveLimits(task, args = {}) {
  const pick = (flag, key) => {
    for (const value of [
      args[flag],
      task?.limits?.[key],
      DEFAULT_LIMITS[key],
    ]) {
      const number = Number(value);
      if (value !== undefined && value !== true && number > 0) return number;
    }
    return DEFAULT_LIMITS[key];
  };
  return {
    maxMs: pick("max-minutes", "maxMinutes") * 60_000,
    maxRequests: pick("max-requests", "maxRequests"),
  };
}

/**
 * Run one attempt in a new chat tab and record it.
 * @returns the recorder's result plus terminalReason.
 */
export async function runAttempt({
  client,
  entry,
  task,
  prepare,
  readTrace,
  record,
  limits,
  onInput = "stop",
  keepTabs = false,
  sleep,
  now = Date.now,
  pollMs = 2_000,
  startGraceMs = 15_000,
  log = () => {},
}) {
  prepare(task.id);
  const created = await client.newTab(
    focusedSelection(await client.getState()),
  );
  const sessionId = created.sessionId;
  const selection = {
    controllerEpoch: created.controllerEpoch,
    tabId: created.tabId,
    sessionId,
  };
  log(`  tab ${created.tabId} session ${sessionId}`);
  let terminalReason = "completed";
  let intervened = false;
  let detail;
  try {
    const model = entry.vscodeModel ?? entry.model;
    await client.setModel(sessionId, model);
    if (entry.reasoningEffort) {
      await client.setReasoningEffort(sessionId, entry.reasoningEffort);
    }
    const ready = findTab(await client.getState(), sessionId);
    if (ready?.model && ready.model !== model) {
      // A fallback model would silently benchmark the wrong thing.
      terminalReason = "infra";
      detail = `requested ${model}, chat is using ${ready.model}`;
      return await finish();
    }

    await client.send(sessionId, task.prompt, "code");
    const startedAt = now();
    let seenBusy = false;
    let waitingForInput = false;
    for (;;) {
      await sleep(pollMs);
      const tab = findTab(await client.getState(), sessionId);
      if (!tab) {
        terminalReason = "infra";
        detail = "chat tab disappeared";
        break;
      }
      seenBusy ||= tab.busy;
      const elapsed = now() - startedAt;

      if (tab.status === "needs_input") {
        if (onInput === "wait") {
          if (!waitingForInput) {
            log("\u0007  needs input: answer it in the VS Code chat tab");
            waitingForInput = true;
          }
          intervened = true;
        } else {
          terminalReason = "needs_input";
          await stopAndSettle();
          break;
        }
      } else {
        waitingForInput = false;
      }

      if (
        !tab.busy &&
        DONE_STATUSES.has(tab.status) &&
        (seenBusy || elapsed > startGraceMs)
      ) {
        terminalReason = tab.status === "failed" ? "error" : "completed";
        break;
      }
      if (limits.maxMs && elapsed > limits.maxMs) {
        terminalReason = "time_cap";
        await stopAndSettle();
        break;
      }
      const apiCalls = readTrace(sessionId)?.apiCalls;
      if (limits.maxRequests && apiCalls >= limits.maxRequests) {
        terminalReason = "request_cap";
        await stopAndSettle();
        break;
      }
    }
    // Let the session history and trace summary flush before scoring.
    await sleep(pollMs);
    return await finish();
  } catch (error) {
    terminalReason = "infra";
    detail = error instanceof Error ? error.message : String(error);
    await client.stop(sessionId).catch(() => {});
    return await finish();
  }

  async function stopAndSettle() {
    await client.stop(sessionId).catch(() => {});
    for (let waited = 0; waited < 30_000; waited += pollMs) {
      await sleep(pollMs);
      const tab = findTab(await client.getState(), sessionId);
      if (!tab?.busy) return;
    }
  }

  async function finish() {
    const result = record({
      taskId: task.id,
      sessionId,
      label: entry.label,
      terminalReason,
      detail,
      intervened,
    });
    if (!keepTabs) await client.closeTab(selection).catch(() => {});
    return { ...result, terminalReason, detail };
  }
}
