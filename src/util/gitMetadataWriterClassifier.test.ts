import { describe, expect, it } from "vitest";

import {
  classifyPredictableGitMetadataWriter,
  type PredictableGitMetadataWriterSubcommand,
} from "./gitMetadataWriterClassifier.js";

function classify(
  command: string,
  overrides: { env?: boolean; files?: boolean } = {},
) {
  return classifyPredictableGitMetadataWriter({
    command,
    hasEnvironmentOverrides: overrides.env ?? false,
    hasInlineFiles: overrides.files ?? false,
  });
}

const positives: Array<[PredictableGitMetadataWriterSubcommand, string[]]> = [
  [
    "init",
    [
      "git init",
      "git init -q",
      "git init -b main",
      "git init --initial-branch=main --object-format=sha256",
    ],
  ],
  ["add", ["git add src/a.ts", "git add -- 'src/a b.ts'", "git add -A"]],
  [
    "commit",
    [
      "git commit -m 'Add parser'",
      "git commit -a --message='Update files'",
      "git commit --amend --no-edit",
      "git commit -m 'literal $HOME && > output'",
      'git commit -m "literal && > output"',
    ],
  ],
  [
    "rm",
    [
      "git rm -- src/old.ts",
      "git rm -r generated",
      "git rm --cached .env.example",
    ],
  ],
  ["mv", ["git mv old.ts new.ts", "git mv -- 'old name' 'new name'"]],
  [
    "branch",
    [
      "git branch feature HEAD",
      "git branch -d merged",
      "git branch -m old new",
      "git branch -c main experiment",
      "git branch --set-upstream-to=origin/main feature",
    ],
  ],
  [
    "stash",
    [
      "git stash",
      "git stash push -m 'wip' -- src/a.ts",
      "git stash pop --index 'stash@{0}'",
      "git stash drop 'stash@{0}'",
      "git stash branch rescue 'stash@{0}'",
    ],
  ],
  [
    "restore",
    [
      "git restore -- src/a.ts",
      "git restore --staged -- src/a.ts",
      "git restore --source HEAD -- src/a.ts",
    ],
  ],
  [
    "checkout",
    [
      "git checkout main",
      "git checkout -b feature HEAD",
      "git checkout -- src/a.ts",
      "git checkout HEAD -- src/a.ts",
    ],
  ],
  [
    "switch",
    [
      "git switch main",
      "git switch -c feature HEAD",
      "git switch --detach HEAD",
    ],
  ],
  [
    "merge",
    [
      "git merge --no-edit feature",
      "git merge --ff-only --no-edit main",
      "git merge --abort",
      "git merge --quit",
    ],
  ],
  ["merge-tree", ["git merge-tree --write-tree main feature"]],
  [
    "reset",
    [
      "git reset --soft HEAD~1",
      "git reset --mixed HEAD",
      "git reset HEAD -- src/a.ts",
      "git reset -- src/a.ts",
    ],
  ],
  ["remote", ["git remote add origin git@github-personal:owner/repo.git"]],
  [
    "fetch",
    [
      "git fetch",
      "git fetch origin",
      "git fetch origin main",
      "git fetch --all --prune",
      "git fetch --prune --tags origin",
    ],
  ],
  [
    "rebase",
    [
      "git rebase main",
      "git rebase main feature",
      "git rebase --onto new-base old-base feature",
      "git rebase --continue",
      "git rebase --abort",
      "git rebase --skip",
      "git rebase --quit",
    ],
  ],
];

const negatives = [
  "git status",
  "git diff",
  "git log",
  "git branch",
  "git stash list",
  "git pull",
  "git push",
  "git remote -v",
  "git remote add origin",
  "git remote remove origin",
  "git clone example",
  "git init --bare",
  "git init other-directory",
  "git init --separate-git-dir=/tmp/repo.git",
  "git init --help",
  "git clean -fdx",
  "git fetch --dry-run",
  "git fetch --help",
  "git fetch origin main extra",
  "git fetch https://example.com/owner/repo.git",
  "git fetch ssh://git@example.com/owner/repo.git",
  "git fetch git@example.com:owner/repo.git",
  "git rebase -i main",
  "git rebase --interactive main",
  "git rebase --exec test main",
  "git rebase -x test main",
  "git rebase --edit-todo",
  "git rebase --show-current-patch",
  "git rebase --help",
  "git rebase --onto only-new-base",
  "git reset --hard HEAD",
  "git branch -D old",
  "git branch -d -f old",
  "git branch --delete --force old",
  "git branch -m -f old new",
  "git stash clear",
  "git add -p",
  "git commit",
  "git commit --edit -m x",
  "git commit -S -m x",
  "git checkout -B main",
  "git checkout -f -- src/a.ts",
  "git checkout --conflict=diff3 -- src/a.ts",
  "git checkout --pathspec-from-file=list -- src/a.ts",
  "git merge feature",
  "git merge-tree main feature",
  "git merge-tree --trivial-merge main feature",
  "git merge-tree --write-tree main",
  "git merge-tree --write-tree main feature extra",
  "git add --pathspec-from-file=list",
  "git add",
  "git rm",
  "git mv only-one",
  "git checkout HEAD src/a.ts",
  "git switch",
  "git reset HEAD",
  "git reset -q -- src/a.ts",
  "/usr/bin/git add .",
  '"git" add .',
  "sudo git add .",
  "env GIT_DIR=.git git add .",
  "command git add .",
  "time git add .",
  "bash -lc 'git add .'",
  "GIT_DIR=/tmp/repo git add .",
  "git -C sub add .",
  "git -c core.hooksPath=/tmp add .",
  "git --git-dir=.git add .",
  "git --work-tree=. add .",
  "git --namespace=x add .",
  "git --config-env=x=Y add .",
  "git --no-pager add .",
  "git add . && npm test",
  "cd sub && git add .",
  "git add . || git commit -m x",
  "git add .; echo done",
  "git add .\ngit status",
  "git add . # comment",
  "git add . | cat",
  "git add . >out",
  "git add . <in",
  "git add . &",
  'git add "$HOME/file"',
  "git add $(pwd)",
  "git add `pwd`",
  "git add <(find .)",
  "git add *.ts",
  "git add src/{a,b}.ts",
  'git commit -m "from $HOME"',
  "git add 'unterminated",
  "git add trailing\\",
];

describe("classifyPredictableGitMetadataWriter", () => {
  it.each(
    positives.flatMap(([subcommand, commands]) =>
      commands.map((command) => [subcommand, command] as const),
    ),
  )("classifies %s writer: %s", (subcommand, command) => {
    expect(classify(command)).toEqual({
      kind: "predictable_git_metadata_writer",
      subcommands: [subcommand],
    });
  });

  it.each([
    ["git add src/a.ts && git commit -m fix", ["add", "commit"]],
    ["git add src/a.ts && git commit -m 'keep && explain'", ["add", "commit"]],
    ["git fetch origin && git rebase main", ["fetch", "rebase"]],
    [
      "git init -b main && git remote add origin git@github-personal:owner/repo.git && git status --short --branch",
      ["init", "remote"],
    ],
  ] as const)("classifies writer chain: %s", (command, subcommands) => {
    expect(classify(command)).toEqual({
      kind: "predictable_git_metadata_writer",
      subcommands,
    });
  });

  it.each([
    "git status --short && git init",
    "git init && git status --ignored",
    "git init && git remote -v",
  ])("rejects unsafe init chain: %s", (command) => {
    expect(classify(command)).toBeNull();
  });

  it.each(negatives)("rejects ineligible command: %s", (command) => {
    expect(classify(command)).toBeNull();
  });

  it("rejects request data that changes execution outside the command string", () => {
    expect(classify("git add .", { env: true })).toBeNull();
    expect(classify("git add .", { files: true })).toBeNull();
  });

  it.each(["&& true", "|| true", "| cat", ">out", "<in", "&", "# comment"])(
    "rejects transformed writers with %s",
    (suffix) => {
      expect(classify(`git add src/a.ts ${suffix}`)).toBeNull();
    },
  );
});
