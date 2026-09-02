# Why AgentLink

_Last updated: 2026-09-02._

Coding agents have become capable enough to do useful work on real codebases. The question is no longer whether to give them autonomy. It is what kind of environment lets them make good decisions, and what kind of control lets you trust the result.

AgentLink is a coding-agent harness built into VS Code. It is not a forked editor, a separate desktop app, or a hosted agent service. Its bet is simple: **agent quality is not just model quality. It also comes from the editor intelligence, feedback, context discipline, and supervision around the model.**

## The editor is the runtime

Most agents meet a project as a directory tree. They search text, read files, write files, and run shell commands. That is useful, but it misses the understanding already present in a modern editor.

AgentLink works through VS Code, so the agent can navigate definitions and references, inspect symbols and types, use code actions, and see language diagnostics. It gets a structural view of the project before it makes a change, rather than discovering dependencies only after something breaks.

The feedback loop matters just as much. Proposed changes open in VS Code diff views, where you can accept, reject, or adjust them. Diagnostics can return to the agent immediately after a write. Commands run in the integrated terminal you can see, not in an invisible subprocess. The result is a more practical loop: the agent has better evidence, and both of you see mistakes while they are still cheap to fix.

## Autonomy should be a dial

Some tasks need close review. Others need momentum. A useful harness should support both without making you choose a different product or abandon visibility.

AgentLink treats supervision as a dial. You can review edits and commands one by one, add rules for work you understand, or use **Approve for Me** for higher-trust sessions while keeping sensitive boundaries reviewed. Every approval can include a follow-up, so redirecting work becomes part of the conversation instead of a restart.

The important part is that autonomy stays legible. Tool calls, progress, questions, queued work, and approvals are visible as they happen. Background agents report into a shared Fleet view where you can steer, pause, stop, or ask them to wrap up. Checkpoints and revert give you a way to explore aggressively without touching your real Git history.

## Nothing happens in the dark

A spinner is not a status model. When an agent is working, you should be able to tell whether it is thinking, reading, running a command, waiting on a decision, or finished.

AgentLink keeps that detail available without making the transcript unreadable. The Activity Shelf near the composer summarizes the work in progress; the transcript retains the underlying tool calls and results. Agents finish with a clear completed, waiting, blocked, or cancelled state. When a task runs longer than expected, the browser remote lets you check the same session from another device, answer a question, or inspect a read-only diff without moving your editor session.

Transparency is not just reassuring. It is what makes delegation workable. You can let an agent do more when you can glance over and understand what it is doing.

## A second lab can check the first

AgentLink supports frontier models from Anthropic and OpenAI/Codex in the same workflow. That makes cross-provider review possible: one model can build while a model from another provider reviews the result.

This is not a claim that any one model is always right. Different model families have different strengths and blind spots. A reviewer that did not produce the change is more likely to question its assumptions, especially when it can inspect the live working tree and surrounding code rather than a small isolated patch.

You choose the models, accounts, and review depth. AgentLink supplies the coordination, the review boundary, and the visibility needed to make a second opinion part of normal work instead of a ceremony you skip when the deadline arrives.

## Spend context on the code

Long agent sessions fail as much from bad context as from bad reasoning. Repeated files, noisy command output, giant tool catalogs, and stale conversation can crowd out the code that actually matters.

AgentLink treats context as a resource. Its local codebase index provides lexical and structural retrieval without a cloud service. Tool and MCP schemas are progressively disclosed rather than dumped into every request. File reads can omit ranges the agent already received, terminal output can be bounded, and long sessions can condense while carrying the active task forward.

The goal is straightforward: spend model attention on the codebase and the decision at hand, not on the harness talking to itself.

## Integrate instead of rebuilding everything

AgentLink builds deeply where VS Code has an advantage: editor intelligence, reviewed changes, terminal visibility, and session supervision. For the rest, it leans into open conventions and the MCP ecosystem.

Connect MCP servers for browser automation, issue trackers, databases, internal tools, and other services. Keep the instructions, skills, slash commands, and compatible hooks your projects already use. Agent Plugins extend those workflows with a reviewed package boundary instead of a host-specific marketplace dependency.

The aim is not to make every capability proprietary. It is to make the capabilities you bring into an agent workflow visible, governed, and useful in the same place.

## Your machine and your accounts

AgentLink runs as a VS Code extension on your machine. It uses the provider accounts you choose—ChatGPT/Codex, OpenAI, Anthropic, or compatible endpoints—at their provider rates. There is no AgentLink cloud execution service or model middleman.

Local code indexes, retrieval data, and telemetry stay on-device by default. Provider-backed features send only the inputs they need. The browser remote is a local helper-owned relay over loopback or an explicitly paired LAN connection, not a hosted relay service.

Because AgentLink is an extension rather than an editor replacement, the rest of your VS Code setup keeps working too: language tooling, proprietary extensions, marketplace access, and the completion tools you already prefer.

## What AgentLink deliberately does not do

- **No proprietary model and no inline autocomplete.** AgentLink coordinates the models you choose and coexists with your preferred completion extension.
- **No cloud-hosted agent execution.** The agent runs on your machine under the supervision you configure.
- **No ungoverned memory.** Autonomous memory is scoped, auditable, reversible evidence—not hidden instruction or permission.
- **No remote shell in the browser.** The browser surface is for supervision; mutation stays in VS Code.

## Where it is still maturing

AgentLink is ambitious software and some areas are still being hardened. Best-of-N and scheduled automations are available but maturing. Provider support will broaden over time, and richer provider-native features are not all portable across endpoints. The browser remote remains intentionally narrower than VS Code.

Those limits are part of the product story, not footnotes. The aim is to earn more autonomy by making its boundaries visible and dependable.

## The bet

Many tools can run an agent for you. AgentLink is built for the work after the demo: real repositories, long tasks, competing constraints, and changes that deserve a second look.

When the agent has the editor's intelligence, disciplined context, visible execution, and a way to be steered, reviewed, and undone, you can ask more of it without giving up control.
