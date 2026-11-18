// Finds AgentLink chat sessions in a workspace's .agentlink/history, so a
// bench attempt can be scored without copying a session ID out of VS Code.

import * as fs from "node:fs";
import * as path from "node:path";

/** Foreground sessions, newest first. Skips background agents. */
export function listSessions(historyDir, { since = 0, limit } = {}) {
  if (!fs.existsSync(historyDir)) return [];
  const sessions = [];
  for (const entry of fs.readdirSync(historyDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(historyDir, entry.name);
    // Cheap prefilter: a session touched before `since` cannot have started after it.
    if (since && fs.statSync(dir).mtimeMs < since) continue;
    const summary = readJson(path.join(dir, "metadata.json"))?.summary;
    if (!summary || summary.background) continue;
    if ((summary.createdAt ?? 0) < since) continue;
    sessions.push({
      id: summary.id ?? entry.name,
      dir,
      title: summary.title ?? "",
      model: summary.model ?? null,
      mode: summary.mode ?? null,
      createdAt: summary.createdAt ?? null,
      lastActiveAt: summary.lastActiveAt ?? null,
    });
  }
  sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return limit ? sessions.slice(0, limit) : sessions;
}

/**
 * Sessions started after `since` whose first user message contains the
 * task prompt, newest first.
 */
export function findTaskSessions(historyDir, prompt, since) {
  return listSessions(historyDir, { since }).filter((session) =>
    firstUserText(session.dir).includes(prompt.trim()),
  );
}

function loadMessages(sessionDir) {
  const stored = readJson(path.join(sessionDir, "messages.json"));
  return Array.isArray(stored) ? stored : (stored?.messages ?? []);
}

/**
 * How a chat used its TODO list: todo_write calls, model requests (assistant
 * messages) whose only tool calls were todo_write, whether a list was ever
 * started, and whether the final status ticked it off with completeTodos.
 * Null when the session has no stored messages.
 */
export function todoMetrics(sessionDir) {
  const messages = loadMessages(sessionDir);
  if (messages.length === 0) return null;
  let calls = 0;
  let todoOnlyRequests = 0;
  let completedViaStatus = false;
  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    const names = message.content
      .filter((block) => block?.type === "tool_use")
      .map((block) =>
        block.name === "call_native_tool" &&
        typeof block.input?.name === "string"
          ? block.input.name
          : block.name,
      );
    const todos = names.filter((name) => name === "todo_write").length;
    calls += todos;
    if (todos > 0 && todos === names.length) todoOnlyRequests++;
    for (const block of message.content) {
      if (
        block?.type === "tool_use" &&
        block.name === "set_task_status" &&
        block.input?.completeTodos === true
      ) {
        completedViaStatus = true;
      }
    }
  }
  return {
    calls,
    todoOnlyRequests,
    listStarted: calls > 0,
    completedViaStatus,
  };
}

export function firstUserText(sessionDir) {
  const messages = loadMessages(sessionDir);
  const first = messages.find((message) => message?.role === "user");
  if (!first) return "";
  if (typeof first.content === "string") return first.content;
  if (!Array.isArray(first.content)) return "";
  return first.content
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .join("\n");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}
