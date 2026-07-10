# Background Agent Parity and Fleet Plan

**Updated:** 2026-07-10
**Status:** Core program implemented; higher-autonomy Phase 6 workflows remain independent follow-ons
**Related roadmap:** [`harness-feature-landscape-2026-top-20.md`](./harness-feature-landscape-2026-top-20.md)

## Objective

Make a background agent as capable and reliable as a foreground AgentLink agent. "Background" should describe scheduling, ownership, and presentation—not a reduced prompt, reduced tool set, or lower-quality execution path.

The end state is a local-first agent fleet in which agents can:

- run any normal AgentLink mode with that mode's permissions;
- receive the same project instructions, rules, memory, skills, MCP tools, context management, and provider support as foreground sessions;
- implement, test, review, debug, plan, and coordinate work within explicit delegated scope;
- ask questions and request approvals through session-aware routing;
- spawn and supervise child agents when fleet policy permits;
- survive long-running work through persistence, recovery, budgets, and cancellation propagation;
- appear in a unified Agent HQ with ancestry, status, attention, usage, and result evidence.

This plan supports roadmap candidates 1 (Agent HQ), 2 (notifications), 5 (budgets), 8 (diff review), 9 (forking), 12 (browser verification), 15 (best-of-N), 16 (persistent goals), and 17 (automations).

## Product principles

1. **One agent runtime.** Foreground and background sessions use the same prompt and execution machinery. Differences are expressed as session metadata and policy.
2. **Mode defines capability.** Review, architect, ask, debug, and code modes retain their intended tool policies regardless of where an agent runs.
3. **Delegation defines scope.** A parent may constrain owned paths, forbidden paths, expected result, budget, and permission profile. "Background" itself is not a permission profile.
4. **Controls are session-scoped.** Switching mode, updating task state, asking a question, or approving an operation must target the originating session rather than implicitly mutating the foreground session.
5. **Safety lives in policy and containment.** Named permission profiles, parameter-aware authorization, approval routing, budgets, worktrees, and future sandboxing protect autonomous work. Capability should not be removed ad hoc.
6. **Fleet limits are scheduler concerns.** Concurrency, depth, cost, and fairness are enforced centrally and reported explicitly.
7. **Every terminal state is explainable.** Completion, failure, cancellation, budget exhaustion, provider stall, and parent shutdown produce durable results and visible reason codes.

## Current-state gaps

The current native background path already provides concurrent sessions, routing, status/result/kill tools, transcripts, approvals/questions, auto-condense, and VS Code/browser projections. The following differences block full parity:

| Area | Current behavior | Target behavior |
|---|---|---|
| Prompt | Review tasks use a lightweight prompt that omits project instructions, memory, rules, skills, provider tuning, and other foreground context | All native sessions use the full prompt pipeline; a short delegation section adds parent/scope metadata |
| Tools | `review` and `readonly-research` profiles impose background-specific allowlists; background sessions lose control tools and memory proposals | Mode and an explicit permission profile determine tools; background placement adds no implicit restriction |
| Mode | Background `onModeSwitch` is disabled to protect foreground state | Mode switches update only the originating session |
| Coordination | Nested background tools are removed and callbacks are unset | Agents may spawn children under scheduler policy and inspect/stop only authorized descendants |
| Task state | `set_task_status` is foreground-only | Task/goal state is session- or node-scoped |
| Review behavior | Prompt asks review agents to finish in 3–5 tool calls and avoid broader exploration | Review mode stays concise but may use whatever evidence is required within scope and budget |
| Routing | Code review defaults to the opposite provider with a fixed thinking override | Same model is the predictable default; alternate-provider review is explicit policy or user choice |
| Reliability | Empty replies are retried, but an in-flight provider stream can wait indefinitely and an internal retry prompt can appear in the transcript | First-token/inactivity watchdogs, bounded recovery, clean internal messages, and durable failure reasons match foreground quality |
| Persistence | Background sessions are hidden from normal history and in-memory parent/result maps are cleaned up | Fleet nodes and ancestry survive reload; archived results remain discoverable |
| Scheduling | One flat concurrent-session limit | Configurable global/per-parent limits, queueing, fairness, depth, budgets, and cancellation propagation |

ACP backends should keep backend-declared limitations such as read-only operation. The UI and result metadata must distinguish an ACP backend limitation from a generic background-agent limitation.

## Target architecture

### Unified session model

Extend the persisted session/fleet metadata rather than creating a second session system:

```ts
interface AgentExecutionMetadata {
  placement: "foreground" | "background" | "worktree" | "remote";
  parentSessionId?: string;
  rootSessionId: string;
  goalId?: string;
  delegationId?: string;
  depth: number;
  permissionProfile?: string;
  budget?: AgentBudget;
  backend: "native" | `acp:${string}`;
}
```

Placement affects UI and scheduling. Mode, permission profile, backend capability, and delegation affect authorization.

### Fleet node lifecycle

Use explicit durable states:

```text
queued -> starting -> running -> waiting_for_approval
                           |-> waiting_for_answer
                           |-> paused
                           |-> completed
                           |-> failed
                           |-> cancelled
                           |-> budget_exhausted
```

Store a terminal reason separately from the lifecycle state. Parent cancellation propagates by default, but the user can detach a child when policy permits. A parent completing with live children must explicitly wait, detach, or cancel them.

### Delegation contract

Replace free-form-only spawning with a structured envelope while retaining `message` for compatibility:

```ts
interface AgentDelegation {
  task: string;
  message: string;
  mode?: string;
  model?: string;
  provider?: string;
  ownedPaths?: string[];
  forbiddenPaths?: string[];
  permissionProfile?: string;
  worktree?: "shared" | "isolated";
  expectedResult?: "text" | "review_findings" | "patch" | "verification";
  budget?: AgentBudget;
}
```

Path declarations are coordination signals until a deterministic policy engine enforces them. The UI and prompt must not imply hard isolation before enforcement exists.

### Scheduler

Introduce one fleet scheduler as the only component allowed to start native or ACP agents. It owns:

- global, per-root, and per-parent concurrency;
- FIFO queueing with room for later priority classes;
- maximum nesting depth and descendant count;
- budget admission and accounting;
- parent/child cancellation and detachment;
- provider/backend capacity;
- recovery of queued/running nodes after extension reload;
- stable lifecycle events consumed by VS Code, browser, notifications, and hooks.

The first release should remain local and in-process. Design the scheduler interface so worktree and future remote runners can implement the same execution contract.

## Delivery plan

Each phase should be independently releasable. Avoid combining parity, recursive spawning, and a new fleet UI into one change.

### Phase 0 — Characterize parity and stabilize recovery

**Goal:** Establish observable behavior and fix the failure mode that motivated this plan.

Work:

- Add a foreground/background capability matrix test covering prompt sections, native tools, MCP disclosure, mode policy, approval routing, questions, context condensation, retry, cancellation, and persistence.
- Add provider-stream first-token and inactivity watchdog coverage with injectable timers.
- Treat retry nudges as internal provider input so they never render as user-authored transcript messages or persist after recovery.
- Give empty-response and stalled-stream recovery explicit attempt counts and terminal reason codes.
- Surface route, model, provider, reasoning effort, retries, and last activity in background debug/status metadata.
- Add a smoke checklist for long-running background execution, approval/question round trips, reload, cancellation, and result delivery.

Acceptance criteria:

- A stalled background request either recovers or reaches a visible retryable failure within configured bounds.
- No synthetic retry message appears as a user message.
- Tests demonstrate which remaining differences are intentional and which are parity gaps.
- Existing foreground retry behavior does not regress.

Likely areas:

- `src/agent/AgentEngine.ts`
- `src/agent/AgentEngine.test.ts`
- `src/agent/AgentSessionManager.ts`
- `src/agent/AgentSessionManager.background.test.ts`
- transcript projections in `src/agent/webview` and `src/browser-gateway`

### Phase 1 — Native background capability parity

**Goal:** Remove the reduced-agent execution path.

Work:

- Stop setting `lightweight` solely because a task is a background review.
- Build all native background prompts through the full prompt pipeline.
- Replace the restrictive review background section with concise delegation metadata and coordination rules.
- Remove the 3–5 tool-call instruction.
- Stop applying `review`/`readonly-research` tool profiles merely because a task is background work. Preserve restrictions when the user explicitly selects a permission profile or a genuinely read-only backend.
- Make same-model/same-provider routing the default for capability predictability. Retain explicit `model`, `provider`, tier, and independent-review routing options.
- Restore normal skill/rule loading, MCP disclosure, dev feedback, and project instructions for native background sessions.
- Publish a machine-readable capability descriptor for each backend/session so the UI can explain real limitations.

Acceptance criteria:

- Given the same mode, model, permission profile, and workspace, foreground and native background sessions receive equivalent prompt components and tools except fleet-management controls gated by later phases.
- A code-mode background agent can edit, execute commands, test, use skills, and call MCP tools subject to the same approvals as a foreground code-mode agent.
- Review-mode limitations come from review mode, not placement.
- ACP read-only backends remain read-only and are labeled accordingly.

### Phase 2 — Session-scoped controls and durable fleet records

**Goal:** Remove foreground-global assumptions and make every agent independently manageable.

Work:

- Pass the originating session identity through every tool dispatch and callback.
- Make `switch_mode` update the calling session only.
- Make task status, questions, approvals, recent approvals, and pending operations session-aware.
- Decide memory behavior explicitly: proposals may originate from any capable session, but remain reviewed and attributed.
- Persist parent/root/delegation/backend/routing metadata and terminal results in `SessionStore`.
- Stop hiding background sessions from all history; introduce archived/placement filters instead.
- Recover fleet records after reload and mark interrupted in-flight work distinctly from model/provider failure.
- Replace transient parent/result maps where persisted relationships are required.

Acceptance criteria:

- Two simultaneous agents can use different modes without affecting each other.
- Approval or question responses always resume the originating agent.
- Reload preserves ancestry, transcript, usage, terminal result, and route metadata.
- Users can distinguish interrupted, failed, cancelled, and completed sessions.

### Phase 3 — Fleet scheduler and recursive delegation

**Goal:** Allow capable agents to coordinate child agents safely.

Work:

- Add a scheduler abstraction over native and ACP launches.
- Replace deterministic rejection at the flat concurrency limit with a visible queue; retain an explicit fail-fast spawn option if useful for models.
- Add global/per-root/per-parent concurrency and maximum-depth/descendant policies.
- Expose spawn/status/result/steer/stop tools to background agents with descendant-scoped authorization.
- Record a durable parent/child tree and delegation envelope.
- Propagate cancellation and budget exhaustion; define detach semantics.
- Prevent cycles by construction and reject invalid ancestry.
- Ensure a parent cannot silently finish while owned children continue: it must join, detach, or cancel.
- Add fairness so one root task cannot starve foreground work or other roots.

Initial defaults should be conservative and configurable, for example depth 2, three active agents globally, and two active children per parent. These are scheduler defaults—not capability reductions—and queued work must be visible.

Acceptance criteria:

- A background agent can spawn, monitor, collect, and cancel an authorized child.
- Depth, concurrency, and descendant limits produce structured scheduler results rather than generic tool errors.
- Cancelling a root reliably stops or explicitly detaches descendants.
- Reload cannot orphan a fleet node without a recorded recovery state.

### Phase 4 — Agent HQ and attention management

**Goal:** Make a fleet understandable and controllable from VS Code and the browser.

Work:

- Project sessions, background nodes, ACP runs, and worktree agents into one read model.
- Add tree and flat views with filters for active, needs attention, failed, completed, archived, provider, workspace, and goal.
- Show task, parent, mode, backend, model, worktree, last activity, current tool, usage/budget, and terminal reason.
- Support open transcript, inspect delegation, steer, answer, approve, pause/resume where supported, retry, stop subtree, detach, and archive.
- Retain completed history instead of auto-disappearing it from the only management surface.
- Emit stable, deduplicated attention events for approval, question, completion, failure, and budget thresholds.
- Add desktop/browser notifications only after event identity and read/unread semantics are stable.

Acceptance criteria:

- Every live or historical fleet node is discoverable from both supported surfaces.
- Parent/child relationships and attention state are obvious without opening transcripts.
- Actions target the correct session and behave consistently in VS Code and the browser.

### Phase 5 — Budgets, permissions, and isolated execution

**Goal:** Make powerful agents safe and affordable enough for longer autonomous operation.

Work:

- Add warning and hard limits for tokens, estimated cost, API turns, tool calls, and elapsed time at session, subtree, and goal levels.
- Reserve child budget from the parent/subtree envelope and return unused capacity.
- Add named permission profiles such as `review-only`, `workspace-safe`, and `interactive` using parameter-aware rules.
- Enforce delegation-owned/forbidden paths once the normalized policy API exists.
- Add per-agent audit records for policy decisions and approvals.
- Integrate isolated worktrees as a delegation option for overlapping writes and best-of-N.
- Prototype OS-level containment behind the same permission profile rather than special-casing background agents.

Acceptance criteria:

- Budget exhaustion produces a durable partial result and cancels descendants according to policy.
- Permission decisions are deterministic, attributable, and consistent across foreground/background placement.
- Shared-workspace and isolated-worktree agents are clearly distinguished.
- No UI claims isolation for unenforced free-form scope boundaries.

### Phase 6 — Higher-autonomy fleet workflows

**Goal:** Build roadmap features on the unified fleet substrate.

Candidates:

- structured diff review with machine-readable findings;
- best-of-N across models/providers in isolated worktrees;
- browser verification agents returning screenshots/logs;
- persistent goals that own a plan, fleet tree, permissions, budget, and evidence;
- scheduled/event-triggered local automations;
- lifecycle hooks consuming stable fleet events;
- remote supervision and notification improvements.

Each workflow should use the same scheduler, policy, budget, lifecycle, and Agent HQ model. Do not create feature-specific background runners.

## Cross-cutting schemas

Define these early and version them:

- `AgentDelegation`
- `FleetNode`
- `FleetLifecycleEvent`
- `AgentCapabilityDescriptor`
- `AgentBudget` and `BudgetUsage`
- `AgentTerminalReason`
- structured result envelopes for text, findings, patch, and verification evidence

Events need stable IDs, timestamps, root/parent/session IDs, monotonic sequence where practical, and enough information for replay/deduplication. Avoid placing raw secrets or full tool payloads in notification/event summaries.

## Testing strategy

### Unit and contract tests

- Prompt/tool parity matrix for every built-in mode.
- Backend capability negotiation and ACP limitation labeling.
- Scheduler queue, fairness, depth, cycle rejection, and cancellation propagation.
- Session-scoped mode, approvals, questions, and task status.
- Budget reservation/accounting/terminal reasons.
- Stream watchdog, empty-response recovery, condense recovery, and cancellation races.
- Persistence migration and interrupted-run recovery.

### Integration tests

- Foreground parent -> native child -> native grandchild result flow.
- Native parent -> ACP child with capability mismatch.
- Concurrent shared-workspace agents with approval attribution.
- Root cancellation while children are queued, running, and awaiting approval.
- Extension reload with queued/running/completed fleet nodes.
- VS Code/browser projections and actions against the same fleet state.

### Manual release gates

- Long review and code tasks on each supported provider.
- Empty response, provider disconnect, and no-first-token simulations.
- Permission prompt from multiple simultaneous agents.
- Shared-workspace conflict warning and isolated-worktree workflow.
- Mobile-width Agent HQ attention and approval flows.

## Observability and rollout

Add local diagnostics before changing defaults:

- queue wait, startup latency, time to first token, active/idle duration;
- retry/condense/watchdog counts and terminal reasons;
- model/provider/backend and routing reason;
- tools, tokens, estimated cost, and budget headroom;
- parent/child counts and cancellation propagation latency;
- approval/question wait time.

Roll out parity changes behind one temporary setting if necessary, but avoid a long-lived "legacy background agent" fork. Migrate native backgrounds to the unified path, retain backend capability gates, then delete the reduced prompt/profile path once tests and telemetry are stable.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Concurrent agents edit the same files | Explicit delegation scopes, visible ownership, conflict detection, and isolated worktrees for overlapping work |
| Recursive spawning causes cost or process explosion | Central admission control, depth/descendant limits, subtree budgets, queue visibility, and cancellation propagation |
| Full prompts increase context cost | Measure prompt sections, keep deferred disclosure, improve caching, and optimize shared prompt construction without removing capabilities |
| Session-scoped refactor breaks foreground behavior | Introduce session identity at interfaces first, then migrate one control at a time with two-session tests |
| Provider differences appear as background limitations | Capability descriptors and route metadata; same-model default; explicit fallback reasons |
| Reload leaves work orphaned | Durable lifecycle transitions, interrupted state, idempotent cleanup, and later resumable runners where supported |
| User assumes free-form path scope is enforced | Label advisory scope until parameter-aware policy enforcement ships |
| Agent HQ becomes another session store | Build a projection over the existing persisted session/fleet records |

## Decisions to make before Phase 3

1. Can child agents spawn recursively by default, or only when a parent delegation grants `canDelegate`?
2. Should a parent be allowed to detach children, and who owns their budget/notifications afterward?
3. Is the first scheduler strictly in-process, or must its contract immediately cover worktree windows?
4. Which controls are descendant-scoped versus root-coordinator-only?
5. Are shared-workspace path scopes advisory until Phase 5, or should recursive spawning require isolated worktrees for writable children?
6. What default concurrency/depth values fit provider rate limits and typical developer hardware?

## Recommended first implementation slice

Start with Phase 0 plus the smallest part of Phase 1:

1. Add stalled-stream recovery and hide synthetic retry messages.
2. Add parity contract tests.
3. Remove the lightweight prompt for native review backgrounds.
4. Remove the 3–5 tool-call instruction.
5. Default native background routing to the foreground model unless explicitly overridden.
6. Keep nested spawning disabled temporarily, documented as pending session-scoped controls and scheduler admission.

This slice directly improves the reported failure, makes background reviews materially more capable, and creates the test baseline needed for the session-scoping work. It deliberately does not expose recursive delegation before ownership, cancellation, and admission control exist.

## Definition of done

The program is complete when a native agent moved between foreground and background placement retains the same effective capability for its mode and permission profile; can independently manage its session; can participate safely in a persisted parent/child fleet; and is observable, interruptible, budgeted, and recoverable from both VS Code and the browser.
