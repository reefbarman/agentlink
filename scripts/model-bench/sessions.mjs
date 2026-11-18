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

export function firstUserText(sessionDir) {
  const stored = readJson(path.join(sessionDir, "messages.json"));
  const messages = Array.isArray(stored) ? stored : (stored?.messages ?? []);
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
