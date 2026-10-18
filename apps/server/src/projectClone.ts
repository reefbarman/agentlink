import {
  createGitCommand,
  GitLaunchError,
  type GitCommandOptions,
} from "./gitCommand.js";
import { ProjectCloneError, type CloneRepository } from "./projectCatalog.js";

const MAX_ERROR_OUTPUT = 4_000;

export type GitClonerOptions = GitCommandOptions;

/**
 * Clone with `git clone -- <url> <directory>` in the project folder. Git
 * never prompts (a private repository fails instead of hanging), and only
 * the tail of its output is kept for the error.
 */
export function createGitCloner(options: GitClonerOptions): CloneRepository {
  const git = createGitCommand(options);
  return async ({ url, directory, cwd }) => {
    let exit;
    try {
      exit = await git({
        args: ["clone", "--", url, directory],
        cwd,
        purpose: "project-setup",
      });
    } catch (error) {
      if (error instanceof GitLaunchError) {
        throw new ProjectCloneError(url, error.message);
      }
      throw error;
    }
    if (exit.exitCode === 0) return;
    throw new ProjectCloneError(
      url,
      exit.output.trim().slice(-MAX_ERROR_OUTPUT) ||
        (exit.signal ? `git stopped (${exit.signal})` : "git clone failed"),
    );
  };
}
