import { parseGitHubRepository } from "./githubApi.js";
import type { GitHubConnection } from "./githubConnections.js";
import { describeFinding } from "./taskReview.js";
import type { PublishPermission } from "./taskRepositories.js";
import { evidenceFor, type TaskRun } from "./taskStore.js";

/**
 * When a task may be published, and what its draft pull request says.
 * Publishing needs the repository's standing permission, its connection,
 * and evidence for the exact head commit: the implementation, passing
 * validation (when the repository has commands) and a review.
 */

const MAX_TITLE_LENGTH = 72;
const MAX_BODY_LENGTH = 55_000;

export interface PublishProblem {
  readonly code: string;
  readonly detail?: string;
}

export function publishProblem(input: {
  readonly task: TaskRun;
  readonly validationCommands: readonly string[];
  readonly permission: PublishPermission | undefined;
  readonly connection: GitHubConnection | undefined;
  readonly publisherConfigured: boolean;
  /** The owner asked to publish without a review. */
  readonly allowUnreviewed: boolean;
  /** Publishing on its own after the task became ready. */
  readonly automatic: boolean;
}): PublishProblem | undefined {
  const { task } = input;
  if (!input.publisherConfigured) {
    return {
      code: "publisher_not_configured",
      detail: "The server has no publisher, so it cannot push to GitHub.",
    };
  }
  if (!parseGitHubRepository(task.repository)) {
    return { code: "repository_not_github" };
  }
  if (!input.permission) {
    return {
      code: "publish_permission_missing",
      detail:
        "Grant this repository permission to publish (with a GitHub connection) first.",
    };
  }
  if (!input.connection) return { code: "connection_not_found" };
  if (
    task.connectionId &&
    task.connectionId !== input.permission.connectionId
  ) {
    return {
      code: "connection_changed",
      detail:
        "The repository now publishes with another GitHub connection than this task's commits credit. Start the task again, or grant its original connection.",
    };
  }
  const head = task.headCommit;
  const evidence = evidenceFor(task, head);
  if (!head || !evidence.implementation) {
    return { code: "implementation_not_current" };
  }
  if (input.validationCommands.length > 0) {
    const validation = evidence.validation;
    const ran = validation?.commands.map((result) => result.command) ?? [];
    const current =
      validation?.passed === true &&
      ran.length === input.validationCommands.length &&
      ran.every(
        (command, index) => command === input.validationCommands[index],
      );
    if (!current) {
      return {
        code: "validation_not_passed",
        detail:
          "The repository's validation commands have not passed on this commit.",
      };
    }
  }
  if (!evidence.review) {
    if (input.allowUnreviewed && !input.automatic) return undefined;
    return {
      code: "review_missing",
      detail: "No review of this commit; publish it without one explicitly.",
    };
  }
  if (input.automatic && evidence.review.verdict !== "approve") {
    return {
      code: "review_open_findings",
      detail: "The review still has blocking findings: publish it yourself.",
    };
  }
  return undefined;
}

export function pullRequestTitle(task: TaskRun): string {
  const line =
    task.objective
      .split("\n")
      .map((entry) => entry.trim())
      .find(Boolean) ?? "AgentLink task";
  return line.length > MAX_TITLE_LENGTH
    ? `${line.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
    : line;
}

export function pullRequestBody(task: TaskRun): string {
  const head = task.headCommit ?? "";
  const evidence = evidenceFor(task, head);
  const lines: string[] = [task.objective.trim(), ""];
  if (task.summary) {
    lines.push("### Summary", "", task.summary.trim(), "");
  }
  lines.push("### Validation", "");
  const validation = evidence.validation;
  if (!validation) {
    lines.push("No validation commands are set for this repository.");
  } else {
    for (const result of validation.commands) {
      const status = result.timedOut
        ? "timed out"
        : result.exitCode === 0
          ? "passed"
          : `failed (exit ${result.exitCode ?? "signal"})`;
      lines.push(
        `- \`${result.command.replace(/`/gu, "'")}\`: ${status} (${formatDuration(result.durationMs)})`,
      );
    }
  }
  lines.push("", "### Review", "");
  const review = evidence.review;
  if (!review) {
    lines.push("Not reviewed: published without a review by the owner.");
  } else {
    lines.push(
      `${review.verdict === "approve" ? "Approved" : "Changes requested"} by \`${review.model}\`${task.fixRounds ? ` after ${task.fixRounds} fix round${task.fixRounds === 1 ? "" : "s"}` : ""}.`,
    );
    if (review.findings.length > 0) {
      lines.push("", ...review.findings.map(describeFinding));
    }
  }
  lines.push(
    "",
    "---",
    `Opened by AgentLink Assistant for task \`${task.id}\` at \`${head.slice(0, 12)}\`. The checks above ran on that exact commit.`,
  );
  const body = lines.join("\n");
  return body.length > MAX_BODY_LENGTH
    ? `${body.slice(0, MAX_BODY_LENGTH)}\n\n(Shortened.)`
    : body;
}

function formatDuration(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`;
}
