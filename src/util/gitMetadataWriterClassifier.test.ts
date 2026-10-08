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
  [
    "add",
    [
      "git add src/a.ts",
      "git add -- 'src/a b.ts'",
      "git add -A",
      "git -c color.ui=false add -- src/a.ts",
      "printf 'y\\nn\\n' | git -c color.ui=false add --patch -- src/a.ts",
      "printf '%s\\n' y n | git add -p -- 'src/a b.ts'",
    ],
  ],
  [
    "apply",
    [
      "git apply --cached /tmp/notes.patch",
      "git apply --cached --check --apply /tmp/notes.patch",
      "git apply --check --index --apply 'patch with spaces.diff'",
      "git apply --index a.patch b.patch",
      "git apply --cached",
      "git apply --cached -",
      "git apply --cached -- -odd-name.patch",
      "git -c color.ui=false apply --cached /tmp/notes.patch",
      "git apply --cached -R --recount --whitespace=nowarn -p 1 -C 2 a.patch",
      "cat /tmp/notes.patch | git apply --cached",
      "printf '%s' 'literal patch' | git apply --index --check --apply",
      "git diff -- src/a.ts | git apply --cached",
      "git diff -- src/a.ts | python3 -c 'import sys; print(sys.stdin.read())' | git apply --cached",
    ],
  ],
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
    "config",
    [
      "git config --local user.name 'Example User'",
      "git config --local user.email example@example.com",
      "git config --local --add user.email example@example.com",
    ],
  ],
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
  "git apply notes.patch",
  "git apply --check notes.patch",
  "git apply --cached --check notes.patch",
  "git apply --index --check notes.patch",
  "cat notes.patch | git apply --cached --check",
  "git apply --cached --stat notes.patch",
  "git apply --cached --numstat notes.patch",
  "git apply --index --summary notes.patch",
  "git apply --cached --stat --apply notes.patch",
  "git apply --cached --no-cached notes.patch",
  "git apply --3way notes.patch",
  "git apply --cached --unsafe-paths notes.patch",
  "git apply --index --reject notes.patch",
  "git apply --cached --whitespace=unknown notes.patch",
  "git apply --cached -p invalid notes.patch",
  "git apply --cached --directory=/tmp notes.patch",
  'git apply --cached "$PATCH"',
  "git apply --cached $(cat patch-path)",
  "git -C sub apply --cached notes.patch",
  "git --git-dir=/tmp/other apply --cached notes.patch",
  "env GIT_DIR=/tmp/other git apply --cached notes.patch",
  "bash -c 'git apply --cached notes.patch'",
  "cat notes.patch | 'git apply --cached'",
  "printf 'git apply --cached notes.patch'",
  "cat notes.patch | git apply --cached | cat",
  "cat notes.patch > other | git apply --cached",
  "cat $(pwd)/notes.patch | git apply --cached",
  "cat notes.patch || git apply --cached",
  "cat notes.patch | | git apply --cached",
  "cd sub | git apply --cached",
  "env GIT_DIR=/tmp/other cat notes.patch | git apply --cached",
  "git -C sub diff | git apply --cached",
  "git diff -- src/a.ts | bash -c 'cat' | git apply --cached",
  'git diff -- src/a.ts | python3 -c "$FILTER" | git apply --cached',
  "git status",
  "git status --short && git diff --cached --stat",
  "git status --short; git diff --check",
  'test -z "$(git status --short)" && git commit -m fix',
  'test -z "$(printf plans)" && git commit -m fix',
  'test -z "$(git ls-files $(touch marker))" && git commit -m fix',
  'test -z "$(git ls-files docs; touch marker)" && git commit -m fix',
  "git ls-files -z > paths | xargs -0 git add --",
  "git ls-files -z * | xargs -0 git add --",
  "git ls-files -z | 'xargs -0 git add --'",

  "git ls-files -z | xargs -0 sh -c 'git add -- \"$@\"' sh && git commit -m fix",
  "cd sub && git ls-files -z plans | xargs -0 git add -- && git commit -m fix",
  "GIT_DIR=.git git ls-files -z plans | xargs -0 git add -- && git commit -m fix",
  "git log --oneline",
  "git show --stat",
  "git add . && git log --format=fuller",
  "git add . && git show --pretty=raw",
  "git config --local --get user.email",
  "git config --global user.email example@example.com",
  "git config --local --file alternate user.email example@example.com",
  "git config --local example.key value",
  "git config --local core.hooksPath /tmp/hooks",
  "git config --local core.fsmonitor command",
  "git config --local core.sshCommand command",
  "git config --local alias.inspect '!command'",
  "git config --local include.path /tmp/config",
  "git config --local includeIf.gitdir:repo.path /tmp/config",
  "git config --local filter.example.clean command",
  "git config --local filter.example.smudge command",
  "git config --local diff.example.textconv command",
  "git config --local credential.helper command",
  "git add . && git diff --output result.patch",
  "git add . && git diff --ext-diff",
  "git add . && git diff --textconv",
  "git add . && git ls-files --with-tree HEAD",
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
  "git add .; git status --ignored",
  "git add .; ; git status --short",
  "; git add .",
  "git add .;",
  "git add .\ngit status",
  "git add . # comment",
  "git add . | cat",
  "printf 'y\\n' | git -c core.hooksPath=/tmp add --patch -- src/a.ts",
  "printf 'y\\n' | git -C sub add --patch -- src/a.ts",
  "printf 'y\\n' | git -c color.ui=false -c alias.foo=!evil add --patch -- src/a.ts",
  'printf "$ANSWERS" | git add --patch -- src/a.ts',
  "printf '%s' $(cat answers) | git add --patch -- src/a.ts",
  "printf -v answers y | git add --patch -- src/a.ts",
  "cat answers | git add --patch -- src/a.ts",
  "printf 'y\\n' | git add --patch -- src/a.ts | cat",
  "printf 'y\\n' | git commit -m x",
  "printf 'y\\n' | git add --patch -- src/a.ts > out",
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
    [
      "git apply --cached --check /tmp/notes.patch && git apply --cached /tmp/notes.patch && git add -- src/a.ts",
      ["apply", "add"],
    ],
    [
      "git diff --cached --quiet && git diff -- src/a.ts | python3 -c 'import sys; print(sys.stdin.read())' | git apply --cached && git add -- docs/a.md",
      ["apply", "add"],
    ],
    ["git add src/a.ts && git commit -m 'keep && explain'", ["add", "commit"]],
    ["git fetch origin && git rebase main", ["fetch", "rebase"]],
    ["git status --short; git switch --detach abc123", ["switch"]],
    ["git add -- paths && git diff", ["add"]],
    ["git commit -m fix && git log --oneline", ["commit"]],
    ["git commit -m fix && git show --stat", ["commit"]],
    [
      "git add CHANGELOG.md src/a.ts && git diff --cached --stat && git diff --cached --name-only && git ls-files plans && git commit -m fix",
      ["add", "commit"],
    ],
    [
      "git status --short --branch && git diff --check && git config --local user.email example@example.com && git remote add origin git@github-personal:owner/repo.git && git var GIT_AUTHOR_IDENT && git var GIT_COMMITTER_IDENT && git remote -v && git add -A && git diff --cached --check",
      ["config", "remote", "add"],
    ],
    [
      "git init -b main && git remote add origin git@github-personal:owner/repo.git && git status --short --branch",
      ["init", "remote"],
    ],
    [
      'git diff --cached --check && git diff --cached --stat && git diff --stat && test -z "$(git ls-files plans)" && test -z "$(git diff --cached --name-only -- plans)" && git commit -m "feat: add desktop MCP management and harden agent recovery"',
      ["commit"],
    ],
    [
      'test -z "$(git ls-files docs)" && test -z "$(git diff --cached --name-only -- docs)" && git commit -m fix',
      ["commit"],
    ],
    [
      "git ls-files -z plans | xargs -0 git add -- && git commit -m 'stage tracked plan files'",
      ["add", "commit"],
    ],
    [
      "git ls-files -z -- plans | xargs -0 git add -- && git commit -m 'stage tracked plan files'",
      ["add", "commit"],
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

  it("recognises only supported apply workflows with materialised inline inputs", () => {
    expect(
      classify(
        "git apply --cached --check '/tmp/materialised patch' && git apply --cached '/tmp/materialised patch' && git add -- src/a.ts",
        { files: true },
      ),
    ).toEqual({
      kind: "predictable_git_metadata_writer",
      subcommands: ["apply", "add"],
    });
    expect(
      classify("cat '/tmp/materialised patch' | git apply --cached", {
        files: true,
      }),
    ).toEqual({
      kind: "predictable_git_metadata_writer",
      subcommands: ["apply"],
    });
    expect(
      classify("git apply --cached $AL_FILE(patch)", { files: true }),
    ).toBeNull();
    expect(
      classify("git apply --cached patch", { files: true, env: true }),
    ).toBeNull();
    expect(classify("git apply --check patch", { files: true })).toBeNull();
    expect(
      classify("git apply --cached --check patch", { files: true }),
    ).toBeNull();
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
