# ADR 0002: Reject writable real Git metadata in the workspace sandbox

- **Status:** Accepted
- **Date:** 2026-08-06
- **Stage:** Sandbox capability boundary

## Context

AgentLink's workspace-write sandbox keeps repository Git metadata read-only. This causes normal metadata writers such as `git add`, `git commit`, and `git fetch` to receive structured native-execution guidance instead of running in the sandbox.

An attempted internal, command- and repository-bound capability made selected real `.git` directories writable while retaining denies for selected integrity paths such as configuration and hooks. Security review found that this does not create a reliable boundary.

## Decision

Do not allow direct sandbox writes to a real Git metadata directory by subtracting path denies from the `.git` protection.

Retain native-execution guidance for Git commands that mutate protected Git metadata. The sandbox must continue to deny writes to the repository marker, resolved worktree/common Git directories, configuration, hooks, administrative pointers, and discovered Git metadata at other workspace roots.

A removed legacy `allowGitMetadataWrite` request field is rejected at runtime if it reaches the capability validator through an untyped boundary. This prevents stale IPC or serialized requests from being silently accepted after the typed field is removed.

## Rejected model and bypass classes

The rejected model had no safe answer for:

- hard-link and pathname aliases that appear after an initial filesystem snapshot;
- repository-controlled hooks, filters, attributes, and configuration that can execute child processes while real metadata is writable;
- linked worktrees, common Git directories, submodules, nested repositories, and absent administrative paths;
- incomplete integrity-path enumeration and case-insensitive filesystem aliases;
- classifier differences between `execute_command` and the launch authorizer;
- helper-protocol validation gaps and drift between interactive and one-shot helper policy construction.

An allowlist of immutable paths under a writable real `.git` tree is therefore insufficient, even if command, repository, and grant bindings are exact.

## Future direction

A future capability must keep real Git metadata read-only throughout untrusted execution. It requires a host-owned staged transaction with all of these gates:

1. Direct `git` argv execution in a private, byte-copied shadow repository; no user shell text, inherited `GIT_*` state, hooks, arbitrary configuration, or external execution redirects.
2. Confirmed process-tree quiescence before trusted code inspects the shadow state; no background, detach, timeout continuation, or unverified descendant process.
3. Host-derived hostile-delta validation for every object, index, ref, and promoted metadata path.
4. Operation-specific, crash-safe compare-and-swap promotion with Git-compatible locks and repository drift checks.
5. Explicit repository-shape and operation gates, including ordinary non-bare root repositories only until worktrees, submodules, alternate object stores, index extensions, and other features are proven safe.

The operations are not one shared capability class. A foreground-only `git add -- <literal paths>` shadow-index transaction is the narrowest plausible first slice. Commit needs separate index/ref atomicity and recovery work. Fetch needs explicit transport, pack, multi-ref, and `FETCH_HEAD` transaction semantics. Shell chains require their own partial-success and atomicity model.

## Consequences

- No user-facing Git sandbox capability is documented or shipped by this decision.
- `git add`, `git commit`, `git fetch`, and other predictable metadata writers retain reviewed native guidance.
- Future work must start from a staged transaction design rather than reinstating writable-real-`.git` policy exceptions.
- No changelog entry is required because the rejected behavior was never released.
