# Tool Feedback Remediation Plan

## Status

Phases 1–5 are complete for the scoped remediation backlog. The review began with 61 feedback entries and expanded to 74 before the final Phase 5 snapshot on 2026-07-18.

- Source validation and installed-extension verification completed through v1.17.5.
- 71 entries were deliberately closed after verified fixes, explicit no-defect/out-of-scope classification, documented by-design decisions, or a strict current-evidence review.
- 3 entries remain open pending packaged verification; their concrete failure-reporting gaps are now implemented and fully source-validated.
- Four former residual records were closed after failing a 90% confidence threshold for further engineering: two requested semantic filename guessing, and two older background-reload reports are covered by current restoration code/tests without a current reproduction.

## Recommendation

Work through the feedback in reliability-first order:

1. fix production failures that can discard or block work;
2. harden security/privacy boundaries;
3. improve edit/read recovery ergonomics;
4. remove narrow validator false positives;
5. verify already-actioned behavior in a packaged extension before closing feedback.

Each phase should include focused tests, full repository verification for production changes, and a packaged/dogfood check when the reported defect appeared only in the installed bundle.

## Disposition Summary

| Theme                                                            | Entries | Status                                           | Priority / evidence                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------- | ------: | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose` initialization                                         |       2 | **Implemented and installed-verified**           | **P0.** Reproduced against installed 1.17.1. QuickJS is isolated in `dist/compose-runtime.mjs`, dynamically loaded by file URL, covered by a built-bundle regression, included in the VSIX allowlist, and verified through top-level plus bridged child calls on installed v1.17.3 and v1.17.4. Feedback closed.                                                                 |
| Background result loss, expected envelopes, reload authorization |       9 | **Implemented; feedback closed**                 | **P0.** Native, ACP, and worktree backends preserve bounded partial/final output, explicit terminal states/retryability, and required-envelope failures. Current foreground restoration reloads durable ancestry, repopulates parent links, and has focused status/result authorization coverage. Two reports from older builds were closed without a current reproduction.      |
| Terminal exit/output durability and close race                   |       4 | **Implemented; feedback closed**                 | **P0/P1.** Numeric shell-end/marker evidence is preserved, code-less markers use bounded exact-event grace, the 20 most recent closed terminals retain bounded output/status, and pending-disposal tombstones prevent stale re-adoption. Source/full validation passed and the original feedback was deliberately closed during Phase 5.                                         |
| `read_file` secret exposure                                      |       1 | **Implemented; feedback closed**                 | **P0 security/privacy.** Shared targeted JSON/JSONC redaction protects eligible settings/config reads in `read_file`, `get_context`, and Browser Ask Agent. Malformed eligible content fails closed; metadata does not expose key names; raw-byte hashes/metadata are preserved. Independent review and full validation passed; the original feedback was closed during Phase 5. |
| `apply_diff` ambiguity and partial application                   |       8 | **Implemented and installed-verified**           | **P1.** Ambiguous failures include bounded candidate locations; accepted results include final-content SHA-256 and conservative ranges. Per-block occurrence, exact-only replace-all, and opt-in atomic validation use lock-bound reapplication. The newer save-error-detail entry is implemented in source and awaits packaged verification.                                    |
| `get_context` recovery and metadata                              |       6 | **Implemented; feedback closed**                 | **P1.** Empty/EOF/out-of-range requests return valid ranges; high-confidence path suggestions are bounded and multi-root aware; Git status selects the deepest containing repository. Two broader requests were declined because guessing different conceptual filenames belongs to semantic search and would weaken explicit-file recovery precision.                           |
| Multi-root delegated/review paths                                |       2 | **Implemented and installed-verified**           | **P1.** Delegated and review paths canonicalize across all open workspace roots. Equivalent relative/absolute paths and sibling roots work while outside-root and forbidden-path protections remain. Exact file scopes may span roots; Git scopes provide recovery guidance. Feedback closed.                                                                                    |
| `read_file(query=...)` fallback                                  |       1 | **Implemented and installed-verified**           | **P2.** Failed semantic lookup reports an explicit not-found/default-offset state with literal-anchor guidance; explicit offsets and successful anchors remain authoritative. Original feedback closed.                                                                                                                                                                          |
| Command-validator false positives                                |       4 | **Implemented and installed-verified**           | **P2.** Installed dogfood verified exact `ssh -G <host>`, `git cherry-pick --abort`, exact shell `--version`/`--help`, VSCE star-activation acknowledgement, ordinary-operation rejection, and pre-dispatch `command_sent: false`. Feedback closed.                                                                                                                              |
| `search_files(path=<file>)`                                      |       2 | **Installed-verified; feedback closed**          | Installed v1.17.4 supports direct file paths for regex search. The redundant `file_pattern` rejection remains an intentional explicit API validation rather than a correctness defect.                                                                                                                                                                                           |
| BMP/PPM reads and terminal raw-output bloat                      |       2 | **Installed/source verified; feedback closed**   | Installed PPM reading rendered correctly; BMP conversion and read integration are covered by deterministic tests; command results omit duplicate raw terminal output when normalized output is available.                                                                                                                                                                        |
| Compound-command readback                                        |       1 | **Installed-verified; feedback closed**          | Installed validation permits reading a file produced earlier in the same compound command; source coverage includes `cat`, `tail`, and `grep`.                                                                                                                                                                                                                                   |
| Nested-shell filter suggestions                                  |       1 | **Installed-verified; feedback closed**          | Installed v1.17.5 rejects structurally contaminated grep patterns without returning malformed `output_grep` values or unsafe stripped commands. Trustworthy context is preserved, explicit-value guidance is returned, and `command_sent: false` proves the shell payload was not dispatched.                                                                                    |
| Sibling-root `generate_image` output                             |       1 | **Implemented with regression; feedback closed** | Commit `10271a8` removed the cross-project mutation barrier. A tool-dispatch regression now verifies sibling-root `generate_image` invokes workspace-wide checkpoint preparation before handler dispatch.                                                                                                                                                                        |
| Intentional policy requests                                      |      ~5 | **Decline/by design**                            | Do not partially execute mixed commands, automatically rewrite strict-shell commands, place temporary scripts in workspaces by default, add generic repeat-N execution, or infer framework-specific zero-test semantics.                                                                                                                                                         |
| External/caller/environment reports                              |     ~11 | **Close as out of scope/no defect**              | Includes unsupported Vitest flags, duplicate `-t`, zsh's reserved `status`, missing ImageMagick, macOS screenshot permissions, an IDE analyzer warning, GBZEmuHeadless functionality, and three Unity MCP behaviors.                                                                                                                                                             |

## Phase 1 — Production Reliability

### 1.1 Fix bundled `compose` initialization

Status: **implemented and validated in source/build; installed-extension verification pending**.

Implementation direction:

- keep the extension entry as CommonJS;
- emit QuickJS-dependent compose code as a Node ESM bundle;
- dynamically import the bundle using an absolute file URL;
- package the ESM output and source map alongside the existing WASM;
- test the real build output, not only source imports.

Acceptance criteria:

- `dist/extension.js` does not contain the QuickJS runtime bootstrap;
- `dist/compose-runtime.mjs` preserves a valid `import.meta.url`;
- built-bundle tests execute a top-level compose return and a bridged child tool call;
- `npx @vscode/vsce ls` contains the ESM runtime, source map, and QuickJS WASM;
- `npm run lint` and `npm test` pass cleanly;
- a packaged/dev-installed extension executes `compose` without the `createRequire` filename error;
- only then may the two compose feedback entries be closed.

### 1.2 Make background results durable

Status: **implemented and fully validated; feedback closure pending packaged verification**.

Implementation direction:

- persist bounded partial output independently of provider transport;
- preserve a valid final structured marker before transport completion;
- distinguish `running`, `completed`, `incomplete_expected_result`, `failed`, `cancelled`, `budget_exhausted`, `interrupted`, and `authorization_lost`;
- preserve the provider/engine terminal reason and typed retryability instead of guessing transport failures from error strings;
- include liveness and retry-safety metadata;
- wire persisted background-session restoration into production foreground resume;
- authorize restored parent/child relationships by durable ancestry rather than transient manager identity alone.

Acceptance criteria:

- provider disconnect after a valid final marker does not lose the result;
- provider disconnect before a final marker returns preserved partial evidence and an explicit failure state;
- a missing required `review_findings` envelope cannot report successful completion;
- interrupted/reloaded parent sessions can retrieve their restored child result;
- native and provider-backed regression tests cover each state.

Validation completed on 2026-07-18:

- independent review covered manager contracts, native/ACP/worktree result paths, restoration, tool descriptions, and documentation;
- all six review findings were addressed, including worktree result normalization, parsed-envelope precedence after late provider failure, restored output projection, legacy result-state derivation, foreground-switch pruning, and unauthorized payload parity;
- focused background/session/tool tests passed: 3 files, 265 tests;
- `npm run lint` passed cleanly;
- `npm test` passed: 282 files, 3,701 tests;
- `npm run telemetry:tools -- --top 60` completed and recorded all background tool surfaces;
- no feedback entries were deleted.

### 1.3 Preserve terminal completion state

Status: **implemented and fully validated; feedback closure pending packaged verification**.

Implementation direction:

- retain bounded output, capture state, and final exit code for recently closed terminals;
- let `get_terminal_output` retrieve the retained snapshot;
- distinguish running, detached, timed out, completed, and unknown termination;
- suppress terminal re-adoption while disposal is pending.

Acceptance criteria:

- an explicit shell exit status is preserved numerically;
- close-before-end-event and detached-child races retain recoverable output/status;
- `close_terminals({})` does not immediately report disposed terminals as stale remaining terminals;
- focused lifecycle tests and full validation pass.

Implementation evidence:

- terminal lifecycle state now distinguishes `running`, `detached`, `timed_out`, `completed`, and `unknown_termination` while retaining existing `is_running` compatibility;
- exact shell-end events take precedence over code-less markers during a bounded 500 ms grace, while numeric markers remain authoritative fallbacks;
- recently closed terminal snapshots retain final/partial capture metadata and at most 40 KiB each of cleaned/raw output across 20 terminals;
- `get_terminal_output` retrieves closed snapshots by original terminal ID;
- manager-initiated disposal removes the managed record first and tombstones the VS Code terminal object, preventing `close_terminals` from re-adopting it as stale;
- independent audit and code review findings were addressed, including background code-less-marker precedence, idle-state projection, snapshot-state consistency, and tombstone cleanup;
- focused terminal manager/tool/provider/dispatch tests passed: 5 files, 178 tests;
- `npm run lint` passed cleanly;
- `npm test` passed: 282 files, 3,710 tests;
- `npm run telemetry:tools -- --top 60` completed and recorded both terminal tool surfaces;
- no feedback entries were deleted.

## Phase 2 — Security and Safe Editing

### 2.1 Protect secrets in broad settings reads

Status: **implemented and fully validated; feedback closure pending packaged verification**.

Implementation direction:

- target structured JSON/JSONC/settings data rather than arbitrary source text;
- redact values for high-confidence secret key names such as API keys, tokens, passwords, secrets, and authorization values;
- consider a JSON-key selection mode for narrow reads;
- make redaction visible in metadata so callers know content was altered.

Acceptance criteria:

- broad settings reads do not expose unrelated credential values;
- ordinary source code and non-secret configuration values are not over-redacted;
- tests cover nested objects, arrays, common key variants, JSONC, and false-positive cases.

Implementation and validation evidence:

- one shared positional JSONC scanner/redactor protects eligible settings/config `.json` and `.jsonc` paths without scanning arbitrary source code or ordinary JSON data/fixtures;
- high-confidence scalar, object, and array values are replaced while comments, formatting, line count, CRLF/LF/CR sequences, and line offsets remain stable;
- malformed eligible JSON/JSONC fails closed with line-preserving withheld content and metadata that reports only `type` plus `status`; successful redaction metadata reports only `type` plus count, never matched keys;
- `read_file` pagination and literal/regex anchors operate on redacted content, and raw semantic lookup is explicitly skipped for eligible files;
- `get_context` returns redacted content while file size, mtime, and working-set SHA-256 remain based on original bytes;
- Browser Ask Agent applies the same shared helper after read-grant enforcement and preserves VS Code line-splitting parity;
- tests cover path gating, nested values, arrays, duplicate/escaped keys, comments inside strings, trailing commas, mixed newlines, malformed content, narrow-slice/anchor/query bypass attempts, false positives, raw hashing, and Browser Ask Agent parity;
- independent review covered parser/path safety, false positives, malformed behavior, metadata privacy, line preservation, original-byte hashing, all three read surfaces, and documentation; its broad `id` token match and Browser line-splitting findings were fixed, while malformed empty input remains intentionally fail-closed;
- focused shared/read/context tests passed: 4 files, 38 tests;
- Browser Ask Agent integration passed: 1 file, 35 tests;
- `npm run lint` passed cleanly;
- `npm test` passed: 283 files, 3,725 tests;
- `npm run telemetry:tools -- --top 60` completed with zero invalid records;
- `git diff --check` passed;
- no feedback entries were deleted.

### 2.2 Improve `apply_diff` safety and recovery

Status: **all four increments implemented and source-validated; packaged/installed verification pending in Phase 5**.

Deliver incrementally:

1. return line numbers and short snippets for every ambiguous match;
2. return post-edit ranges/content hash for successful blocks in partial results;
3. add explicit per-block occurrence and replace-all controls;
4. add opt-in `atomic: true`, validating all blocks before applying any.

Acceptance criteria:

- callers can correct ambiguous patches without an extra file read;
- intentional repeated replacements do not require a separate tool;
- atomic mode never leaves a partially broken file;
- existing safe ambiguity rejection remains the default unless intentionally changed.

Increment 1 implementation and validation evidence:

- exact, whitespace-flexible, and escape-normalized ambiguous failures report up to 12 candidate 1-based line ranges with compact matching-line snippets plus an omitted count;
- candidate locations shift across later non-overlapping blocks and are omitted if a later successful block overwrites them;
- accepted multi-block/partial results report conservative final-content line ranges for applied blocks, omitting ranges overwritten by later blocks or invalidated by user edits/format-on-save;
- accepted results, including matched no-ops, report `post_edit_content_hash` as SHA-256 of the actual accepted content;
- the VS Code auto-review provider now returns internal final disk content after save, matching the interactive provider; public write handlers continue to strip that content;
- lock-bound reapplication recomputes failed candidates, applied ranges, proposed content, and final hash against the current file;
- independent review covered exact/flexible/escape ambiguity, sequential shifting/overlap, bounded output, lock reapplication, final-content hashing, and compatibility; its overlapping-candidate concern was fixed;
- focused apply/edit/provider/dispatch tests passed: 7 files, 328 tests;
- `npm run lint` passed cleanly;
- `npm test` passed: 283 files, 3,731 tests;
- no feedback entries were deleted.

Increments 2–3 implementation and validation evidence:

- `block_options` supports a 1-based `occurrence` selector for exact, whitespace-flexible, and escape-normalized candidates while preserving existing match-precedence rules;
- `replace_all: true` intentionally replaces every exact occurrence only and never bulk-applies fuzzy matches;
- controls are keyed by zero-based positional block index, including malformed block slots, and duplicate/missing/conflicting options fail before review;
- exact/flexible/escape candidate ordering is deterministic and escape-selected replacements preserve the matched file escape style;
- replace-all edits apply end-to-start, return file-ordered final ranges, and correctly track expanding replacements;
- controls are reused during provider-owned lock reapplication so stale-file refresh does not drop the caller's selection;
- shared schema/registry definitions and adapter dispatch expose the same controls; README documents default safety and exact-only bulk behavior;
- independent review covered schema semantics, match precedence, escape transforms, range tracking, parsed-index gaps, validation, lock reapplication, final-content hashing, and documentation; all four low-severity findings were addressed;
- focused apply/edit/provider/schema/dispatch tests passed: 7 files, 342 tests;
- `npm run lint` passed cleanly;
- `npm test` passed: 283 files, 3,745 tests;
- no feedback entries were deleted.

Increment 4 implementation and validation evidence:

- `atomic: true` requires every parsed block to apply and rejects malformed blocks before opening review or writing content;
- atomic failures return `atomic: true`, `no_changes_applied: true`, failed-block details, and malformed-block counts where applicable;
- provider-owned lock reapplication repeats the all-block requirement against fresh content and aborts before write if the result becomes partial;
- marker-corruption rejection also reports atomic no-write metadata, while matched no-ops remain accepted with a verified content hash;
- atomic mode composes with positional `block_options`; default non-atomic partial application and safe ambiguity rejection remain unchanged;
- escape-normalized occurrence enumeration covers candidates across mixed escape variants in file order while preserving the existing default first-unique fallback;
- shared schema, registry metadata, adapter assertions, and README documentation expose consistent atomic semantics;
- independent review covered atomic short-circuiting, malformed blocks, lock reapplication, block controls, no-ops, ranges/hashes, default partial behavior, and public-contract parity; its atomic marker metadata and mixed escape-variant findings were fixed, while direct-handler validation was intentionally retained alongside schema validation;
- final focused apply/edit/provider/schema/dispatch tests passed: 7 files, 348 tests;
- `npm run lint` passed cleanly;
- `npm test` passed: 283 files, 3,751 tests;
- `npm run telemetry:tools -- --top 60` reported zero invalid records;
- `npm run fmt:check` and `git diff --check` passed;
- packaged/installed verification remains pending in Phase 5;
- no feedback entries were deleted.

## Phase 3 — Read and Multi-Root Recovery

### 3.1 Fix `get_context` recovery and metadata

Status: **implemented and source-validated; packaged/installed verification pending in Phase 5**.

Implementation direction:

- return a valid out-of-range state without inverted ranges;
- extract/reuse the high-confidence path suggestion helper from `read_file`;
- investigate Git-status repository selection and freshness separately from working-set status.

Acceptance criteria:

- tests cover empty files, exact EOF, and beyond-EOF offsets;
- missing sibling files and one-character directory typos return useful suggestions;
- `git_status` either matches repository state or explicitly reports why it is unavailable/stale.

Implementation and validation evidence:

- empty files and exact-EOF requests return valid 1-based ranges and numbered content;
- beyond-EOF requests return `status: "offset_out_of_range"`, the requested offset, valid bounds, `showing: "0-0"`, and a non-inverted `{ startLine: 0, endLine: 0 }` working-set range;
- missing-file errors reuse `read_file`'s bounded suggestion helper without auto-following or changing non-ENOENT errors;
- suggestion discovery searches every request-bound/open workspace root under one shared directory budget, returning compatible relative paths for single-root workspaces and unambiguous absolute paths for multi-root workspaces;
- Git status selects the deepest containing repository and compares canonicalized target/change paths, fixing nested-repository and symlink-spelling mismatches without conflating Git state with working-set content history;
- the first-root source contract records the intentional removal of first-root-only suggestion discovery;
- independent review covered range/dedupe behavior, missing-file recovery, multi-root traversal, Git repository/path selection, clean-state semantics, and tests; its test-isolation and duplicate-redaction-metadata findings were fixed;
- expanded focused context/read/provider/approval/first-root tests passed: 5 files, 48 tests;
- all TypeScript programs and oxlint passed with zero warnings;
- `npm test` passed: 283 files, 3,757 tests;
- all seven Phase 3.1 files pass `oxfmt --check`;
- repository-wide `npm run lint` was blocked only by concurrent formatting drift in unrelated `plans/acp-foreground-provider-plan.md`, which was intentionally left untouched;
- `npm run telemetry:tools -- --top 60` reported zero invalid records;
- `git diff --check` passed;
- no feedback entries were deleted.

### 3.2 Make semantic-query fallback explicit

Status: **implemented and fully source-validated; packaged/installed verification pending in Phase 5**.

Acceptance criteria:

- failed `read_file(query=...)` lookup reports `semantic_match.status = "not_found"` or equivalent;
- the response recommends `anchor`/`anchor_regex` for exact text;
- it does not silently imply that line 1 was semantically relevant.

Implementation and validation evidence:

- eligible `query` requests that produce no semantic chunk now return `semantic_match.status: "not_found"`, `fallback: "default_offset"`, and guidance to use `anchor`/`anchor_regex` for exact text;
- successful semantic ranges and structured-redaction skip metadata remain unchanged;
- explicit `offset` and successful anchors remain authoritative and do not claim semantic lookup failed;
- semantic metadata is attached before out-of-range early returns so stale index ranges are not silently lost;
- README documents successful, not-found, and structured-redaction semantic states;
- focused `read_file` and approval tests passed: 2 files, 23 tests;
- Phase 3.2 files pass scoped Oxfmt and oxlint checks, TypeScript diagnostics are clean, and `git diff --check` passed;
- final repository-wide `npm run lint` passed with zero warnings;
- final `npm test` passed: 283 files, 3,774 tests;
- no feedback entries were deleted.

### 3.3 Canonicalize delegated and review paths

Status: **implemented and fully source-validated; packaged/installed verification pending in Phase 5**.

Implementation direction:

- canonicalize both policy scopes and requested paths against the effective/open workspace roots;
- accept absolute paths that resolve inside an explicitly open root;
- preserve forbidden-path precedence;
- keep `working_tree` Git-specific, but recommend `files` for non-Git workspaces.

Acceptance criteria:

- equivalent relative and absolute paths receive the same delegation decision;
- sibling-root paths work without user knowledge of an arbitrary primary root;
- outside-workspace and forbidden paths remain denied;
- errors identify the resolved root and an accepted example.

Implementation and validation evidence:

- delegated write paths, `ownedPaths`, and `forbiddenPaths` are compared as canonical filesystem paths rather than normalized strings;
- relative delegated scopes expand across all open workspace roots, so absolute paths under equivalent sibling-root scopes are accepted while forbidden scopes retain precedence;
- new/nonexistent targets preserve their suffix beneath the canonical owning root, and relative scopes canonicalize through intermediate symlinks;
- delegated targets outside all workspace roots are denied and audited at the delegation layer even when only forbidden scopes are configured;
- review scopes accept absolute paths inside any open workspace root; exact `files` snapshots may span roots and use unambiguous labels;
- `working_tree` and `commit_range` scopes select the owning root/repository from their filters and reject multi-root Git filters with a `kind: "files"` recovery hint;
- non-Git `working_tree` errors recommend `kind: "files"`, while outside-root errors list allowed roots and an accepted path example;
- AgentSessionManager supplies the current workspace-folder roots to immutable snapshot capture; core contracts, tool metadata, and README document the same semantics;
- root comparison/deduplication is platform-aware, and lexical-to-canonical mapping handles symlinked roots plus missing target files;
- independent review covered containment, symlinks, new paths, forbidden precedence, outside-root safety, Git-root selection, manager wiring, and public contracts; its three path-policy findings were fixed. An unrelated background image-aggregation finding was left to the owning background-result work;
- focused snapshot/delegation/manager tests passed: 3 files, 223 tests;
- `npm run lint` passed with zero warnings;
- `npm test` passed: 283 files, 3,774 tests;
- `npm run telemetry:tools -- --top 60` reported zero invalid records;
- Phase 3 files pass scoped Oxfmt and `git diff --check` passed;
- no feedback entries were deleted.

## Phase 4 — Narrow Validator Fixes

Status: **implemented and fully source-validated; packaged/installed verification pending in Phase 5**.

Implemented and tested together:

- allow local-information SSH modes such as `ssh -G` while continuing to block actual remote connections;
- allow non-editor Git control modes such as `git cherry-pick --abort`;
- allow shell `--version`/`--help` modes;
- detect or clearly report the known VSCE star-activation prompt;
- add `command_sent: false` to pre-dispatch rejection payloads if it can be done compatibly.

Acceptance criteria:

- each reported false positive has a focused regression test;
- ordinary SSH and editor-opening Git operations remain protected;
- `force` is not broadened into a generic interactive-validator bypass.

Implementation and validation evidence:

- `ssh -G <host>` is accepted only as exact local configuration inspection; trailing commands, reordered/combined flags, and ordinary SSH remain rejected;
- `git cherry-pick --abort` bypasses only editor-opening detection, while normal cherry-picks without `--no-edit` remain rejected;
- shell information mode accepts only a sole `--version` or `--help` argument; short or mixed flags such as `sh -v` and `bash --help -i` remain blocked;
- direct `vsce package` and `npx @vscode/vsce package` require `--allow-star-activation`, while unrelated npm/npx and non-package VSCE commands remain unaffected;
- `force` remains limited to explained direct pipe-validator false positives and cannot bypass pipe filtering, malformed shell syntax, protected writes, or interactive validation;
- deterministic pre-dispatch failures report `command_sent: false`, including unavailable/empty commands, malformed/validator/protected-write failures, approval rejection/cancellation, inline-file validation, read-only policy rejection, and edited-command revalidation;
- successful terminal-provider dispatch preserves `command_sent: true`; the generic catch intentionally does not claim `false` because providers may throw after dispatch;
- independent review covered SSH, Git, shell information flags, VSCE detection, force policy, dispatch provenance, and test coverage; valid compact-SSH and non-package VSCE test gaps were added, while the suggestion to allow trailing SSH commands was declined because the exception is intentionally local-inspection-only;
- final focused Phase 4 tests passed: 4 files, 367 tests;
- `npm run lint` passed cleanly with all TypeScript programs and zero-warning oxlint;
- `npm test` passed: 283 files, 3,799 tests;
- `npm run telemetry:tools -- --top 60` reported zero invalid records;
- `npm run fmt:check` and `git diff --check` passed;
- no feedback entries were deleted.

## Phase 5 — Packaged Verification and Feedback Closure

Status: **complete through installed v1.17.5; 3 source-implemented residual entries retained pending packaged verification**.

Before closing actioned feedback:

- build/package the current extension;
- confirm `npx @vscode/vsce ls` includes every required output;
- run focused dogfood cases for `compose`, `search_files(path=<file>)`, BMP/PPM reads, compound-command readback, and sibling-root `generate_image`;
- rerun `npm run telemetry:tools -- --top 60` after material tool changes;
- inspect relevant feedback entries again;
- delete/close only entries whose disposition is verified and deliberate.

Closure rules:

- **Actionable:** keep until implementation and packaged verification pass.
- **Partly actioned:** keep until the residual scenario is covered.
- **Actioned in HEAD:** keep until packaged behavior matches HEAD.
- **Decline/by design:** close with the safety/product rationale recorded.
- **External/caller/environment:** close as out of scope or no defect; route externally when there is a known owner.

Completion evidence:

- `npm run release -- --install` produced and installed v1.17.3 across all VS Code profiles; initial dogfood found one real `get_context` adapter gap;
- the VS Code document-provider adapter now normalizes the host's unstructured nonexistent-file error to the shared `FileNotFound` contract, with adapter and end-to-end suggestion regressions;
- sibling-root `generate_image` now has explicit tool-dispatch coverage proving workspace-wide checkpoint preparation occurs before handler dispatch;
- an independent review found two low-severity recovery-test/maintenance gaps; both were addressed;
- final focused recovery/delegation tests passed: 4 files, 171 tests;
- final `npm run lint` passed cleanly with all TypeScript programs and zero-warning oxlint;
- final `npm test` passed: 283 files, 3,801 tests;
- `npm run release -- --install` then produced and installed v1.17.4 across all VS Code profiles;
- `npx @vscode/vsce ls --tree` and direct VSIX/installed-file inspection confirmed `extension.js`, `compose-runtime.mjs`, its source map, and QuickJS WASM are packaged;
- installed v1.17.4 `compose` executed both top-level JavaScript and bridged child tools without the former QuickJS initialization error;
- installed dogfood verified direct-file `search_files`, valid out-of-range `get_context`, directory-typo suggestions, command-validator safe/rejected modes with `command_sent` provenance, compound-command readback, and PPM rendering;
- deterministic source tests cover BMP conversion/read integration and sibling-root image checkpoint dispatch without consuming image-generation quota;
- final telemetry reported 50,124 calls, 0 invalid records, and successful installed `compose` calls after seven historical failures;
- `npm run fmt:check` and `git diff --check` passed;
- 72 feedback entries were re-read with stable indices; two concurrent entries were reviewed separately; 66 were deliberately closed and 8 retained at the Phase 5 snapshot;
- `npm run release -- --install` subsequently produced `releases/agentlink-1.17.5.vsix`, rebuilt the production bundles, and installed v1.17.5 to the default, java, unity, python, csharp, and GBZEmu profiles;
- the user reloaded VS Code, and the active tool runtime plus every profile reported `agentlink.agentlink@1.17.5`;
- installed `execute_command` dogfood reproduced the nested `$(... | grep -E -C 2 'EDGE|FINAL');` shape: rejection preserved `output_grep_context: 2`, omitted the contaminated regex and unsafe stripped command, requested explicit `output_grep`, and returned `command_sent: false`;
- only that verified `execute_command` feedback record was closed, leaving 7 residual entries;
- a subsequent strict-value review closed 4 more records and retained only the 3 current defects below.

Residual feedback backlog:

| Entries | Theme                                              | Why retained                                                                                                                                                                                                                                                                  |
| ------: | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|       2 | `generate_image` no payload/refusal classification | **Implemented in source; packaged verification pending.** Terminal SSE refusal, provider-error, incomplete, and generic no-image states now return structured classification, bounded provider evidence, explicit-or-unknown quota state, and bounded partial-image metadata. |
|       1 | `apply_diff` save failure detail                   | **Implemented in source; packaged verification pending.** Interactive and auto-approved save failures now preserve review state and return bounded document/disk/concurrency/retry diagnostics without exposing file content or claiming unavailable VS Code error detail.    |

Strict-threshold closures:

| Entries | Theme                                 | Disposition                                                                                                                                                                                                                                               |
| ------: | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|       2 | `get_context` conceptual path guesses | **Closed, below 90% confidence.** Mapping `workerFixture.ts` to a test fixture or `DMA.cs` to `DMAController.cs` requires semantic/fuzzy inference rather than high-confidence filesystem correction. `codebase_search` is the appropriate recovery path. |
|       2 | Background authorization after reload | **Closed as likely addressed.** Current restoration persists fleet ancestry, restores child records with their foreground, repopulates parent links, and tests authorized status/result retrieval. Reopen only on a current-version reproduction.         |

## Next Remediation Batch — Image and Edit Failure Diagnostics

Status: **implemented and fully source-validated; packaged verification and feedback closure pending**.

Implementation and validation evidence:

- Codex image-generation SSE parsing classifies explicit `refusal`, `provider_error`, `incomplete`, and generic `no_image` terminal outcomes instead of collapsing every zero-image completion into one error;
- bounded provider event/code/message evidence is preserved, explicit refusal remains authoritative over later generic errors, and explicit terminal failure still wins when partial image data was received;
- quota consumption is reported only when the provider explicitly supplies it and otherwise remains `"unknown"`;
- VS Code and Browser Ask Agent expose the same structured failure metadata and bounded partial-image list; the OAuth credential-refresh retry preserves that metadata and follow-up guidance;
- `apply_diff` save failures compare disk bytes with the pre-edit baseline and report document dirty state, disk state, concurrent-change confidence, retained review state, retryability, and bounded next steps;
- interactive save failure retains the diff snapshot for recovery, while public tool sanitization continues to strip `finalContent`;
- independent review identified OAuth retry metadata loss, missing retry coverage, and refusal-precedence risks; all were fixed with regressions;
- focused retained-feedback tests passed: 4 files, 73 tests;
- the Browser Ask Agent cached-credential image-generation integration test passed: 1 test, with 34 unrelated cases skipped;
- diagnostics were clean for all 10 touched production/test files;
- `npm run lint` passed cleanly across Oxfmt, all TypeScript programs, and zero-warning oxlint;
- `npm test` passed: 283 files, 3,814 tests;
- `npm run fmt:check`, scoped and whole-worktree `git diff --check`, and scoped Oxfmt passed;
- `npm run telemetry:tools -- --top 60` reported 50,995 calls and 0 invalid records;
- the 2 `generate_image` and 1 `apply_diff` feedback records remain open until packaged behavior is verified.

## Next Remediation Batch — Nested-Shell Filter Suggestions

Status: **implemented, installed-verified on v1.17.5, and feedback closed**.

Implementation and validation evidence:

- `parseGrepArgs` now distinguishes exact suggestions from patterns structurally contaminated by attached command-substitution closers instead of trimming punctuation heuristically;
- contaminated cases keep the pipe-filter rejection and any trustworthy context parameter, omit the malformed `output_grep` value, omit the unsafe `strippedCommand`, and direct callers to set `output_grep` explicitly;
- ordinary top-level pipelines retain their existing stripped-command recovery, while quoted regex parentheses, alternation, and semicolons remain unchanged;
- focused regressions cover the reported `$(... | grep ...);` shape and concatenated quoted fragments;
- independent review found one low-severity concatenated-token gap; the scanner and regression coverage were tightened before full validation;
- final focused validator/execute-command tests passed: 3 files, 301 tests;
- `npm run lint` passed cleanly across Oxfmt, all TypeScript programs, and zero-warning oxlint;
- `npm test` passed: 283 files, 3,805 tests;
- scoped Oxfmt, diagnostics, and `git diff --check` passed;
- v1.17.5 was built, packaged, installed across all six VS Code profiles, and activated by reload;
- installed dogfood returned only trustworthy context plus explicit-value guidance, omitted malformed shell syntax and unsafe rewrite guidance, and reported `command_sent: false`;
- the verified `execute_command` feedback entry alone was deleted at that stage; the later strict-threshold review separately closed four more records and retained three current defects.

## Validation Baseline

The original review used source inspection, tests, Git history, packaging inspection, telemetry, and dogfooding against installed 1.17.1. It reproduced:

- the `compose` QuickJS initialization crash;
- missing `get_context` path suggestions;
- malformed beyond-EOF `get_context` ranges;
- old installed `search_files(path=<file>)` behavior despite a source fix.

No feedback was deleted during the original review. Phase 5 later closed 66 entries only after installed verification or explicit disposition; installed v1.17.5 verification closed the nested-shell filter-hint entry. A subsequent 90% confidence review closed four low-confidence/likely-addressed reports. The remaining 3 records have source-implemented fixes and remain open pending packaged verification.
