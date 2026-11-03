import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as z from "zod";

// Manual-smoke MCP testbed for AgentLink. Not used by automated tests.
//
// Exercises the client features AgentLink handles (progress, cancellation,
// form/URL elicitation in both protocol eras, list-changed) and the ones it
// does not yet handle (resource subscriptions, logging, push into the model),
// plus a pull-only mailbox for the agent-messaging experiment.
//
// Run: node packages/node-host/test-fixtures/testbedMcpServer.mjs
// Env:
//   TESTBED_ERA=legacy       serve only the 2025-era `initialize` handshake
//   TESTBED_MAILBOX=<file>   shared mailbox file (default: OS temp dir)
//   TESTBED_TICK_MS=<ms>     clock resource update interval (default 5000)
import {
  McpServer,
  acceptedContent,
  inputRequired,
  inputResponse,
} from "@modelcontextprotocol/server";
import {
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";

import { randomUUID } from "node:crypto";

const MODERN_PROTOCOL = "2026-07-28";
const TICK_MS = Number(process.env.TESTBED_TICK_MS) || 5000;
const MAILBOX_FILE =
  process.env.TESTBED_MAILBOX ||
  path.join(os.tmpdir(), "agentlink-mcp-testbed", "mailbox.json");
const LOG_LEVELS = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
];

const text = (value) => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });

// Logs go to stderr so they never corrupt the stdio JSON-RPC stream.
const debug = (...args) => console.error("[testbed]", ...args);

// ---------------------------------------------------------------------------
// Mailbox: a JSON file shared by every testbed process on this machine.
// Writes are read-modify-write with an atomic rename. Two processes writing
// in the same instant can lose one update; acceptable for manual smoke tests.
// ---------------------------------------------------------------------------

function readMailbox() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MAILBOX_FILE, "utf8"));
    return {
      sessions: parsed.sessions ?? {},
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    };
  } catch {
    return { sessions: {}, messages: [] };
  }
}

function writeMailbox(mailbox) {
  fs.mkdirSync(path.dirname(MAILBOX_FILE), { recursive: true });
  const tmp = `${MAILBOX_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(mailbox, null, 2));
  fs.renameSync(tmp, MAILBOX_FILE);
}

function updateMailbox(mutate) {
  const mailbox = readMailbox();
  const result = mutate(mailbox);
  writeMailbox(mailbox);
  return result;
}

function unreadFor(mailbox, name) {
  return mailbox.messages.filter((m) => m.to === name && !m.readAt);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function createServer() {
  const server = new McpServer(
    { name: "agentlink-testbed", version: "1.0.0" },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
        logging: {},
      },
      instructions:
        "Manual smoke-test server for AgentLink. Tools are grouped by prefix: " +
        "progress_*, elicit_*, tools_*, resource_*, log_*, mailbox_*.",
    },
  );

  const era = () => {
    const version = server.server.getNegotiatedProtocolVersion();
    return version && version >= MODERN_PROTOCOL ? "modern" : "legacy";
  };

  // Sends a notification without letting an unsupported-era error crash a tool.
  const safeNotify = async (label, fn) => {
    try {
      await fn();
      return `${label}: sent`;
    } catch (error) {
      debug(`${label} failed:`, error?.message ?? error);
      return `${label}: failed (${error?.message ?? error})`;
    }
  };

  // ---- Info ---------------------------------------------------------------

  server.registerTool(
    "testbed_info",
    {
      description:
        "Report the negotiated protocol era, client identity, mailbox path, and which features this testbed exercises.",
      inputSchema: z.object({}),
    },
    async (_args, ctx) =>
      text({
        protocolVersion: server.server.getNegotiatedProtocolVersion(),
        era: era(),
        client: server.server.getClientVersion(),
        clientCapabilities: server.server.getClientCapabilities(),
        envelope: ctx.mcpReq.envelope ?? null,
        mailboxFile: MAILBOX_FILE,
        clockTickMs: TICK_MS,
        pid: process.pid,
      }),
  );

  const echoTool = server.registerTool(
    "echo",
    {
      description: "Echo text back.",
      inputSchema: z.object({ text: z.string() }),
    },
    async ({ text: value }) => text(value),
  );

  // ---- Progress and cancellation -------------------------------------------

  server.registerTool(
    "progress_slow_task",
    {
      description:
        "Run for `seconds` seconds, sending a progress notification every `interval_ms`. Stops early and reports cancellation when the client cancels the call.",
      inputSchema: z.object({
        seconds: z.number().int().min(1).max(600).default(10),
        interval_ms: z.number().int().min(100).max(10000).default(1000),
        indeterminate: z
          .boolean()
          .default(false)
          .describe("Omit `total` so the client shows indeterminate progress"),
      }),
    },
    async ({ seconds, interval_ms, indeterminate }, ctx) => {
      const token = ctx.mcpReq._meta?.progressToken;
      const signal = ctx.mcpReq.signal;
      const steps = Math.max(1, Math.round((seconds * 1000) / interval_ms));
      let sent = 0;
      for (let step = 1; step <= steps; step += 1) {
        try {
          await sleep(interval_ms, signal);
        } catch {
          debug(`progress_slow_task cancelled at step ${step - 1}/${steps}`);
          return text(
            `cancelled after ${step - 1}/${steps} steps (${sent} progress notifications sent)`,
          );
        }
        if (token !== undefined) {
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: {
              progressToken: token,
              progress: step,
              ...(indeterminate ? {} : { total: steps }),
              message: `step ${step} of ${steps}`,
            },
          });
          sent += 1;
        }
      }
      return text(
        token === undefined
          ? `done in ${steps} steps; client sent no progressToken so no progress was reported`
          : `done in ${steps} steps; ${sent} progress notifications sent`,
      );
    },
  );

  server.registerTool(
    "progress_hang",
    {
      description:
        "Never finish until cancelled. Use to test the client's cancel button and request timeout.",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      const started = Date.now();
      try {
        await sleep(24 * 60 * 60 * 1000, ctx.mcpReq.signal);
      } catch {
        // cancelled
      }
      return text(`cancelled after ${Date.now() - started} ms`);
    },
  );

  // ---- Elicitation ---------------------------------------------------------

  const profileSchema = z.object({
    name: z.string().describe("Your name"),
    favouriteColour: z
      .enum(["red", "green", "blue", "teal"])
      .describe("Pick a colour"),
    age: z.number().int().min(0).max(150).optional().describe("Optional age"),
    subscribe: z.boolean().default(false).describe("Tick to subscribe"),
  });

  server.registerTool(
    "elicit_form",
    {
      description:
        "Ask the user to fill in a form (text, enum, optional number, boolean with default). Uses `input_required` on the 2026-07-28 era and `elicitation/create` on the 2025 era.",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      if (era() === "modern") {
        const answer = acceptedContent(
          ctx.mcpReq.inputResponses,
          "profile",
          profileSchema,
        );
        if (answer !== undefined) {
          return text({ era: "modern", action: "accept", content: answer });
        }
        const view = inputResponse(ctx.mcpReq.inputResponses, "profile");
        if (view.kind === "elicit") {
          return text({ era: "modern", action: view.action });
        }
        return inputRequired({
          inputRequests: {
            profile: inputRequired.elicit({
              message: "Testbed form: tell me about yourself",
              requestedSchema: profileSchema,
            }),
          },
        });
      }
      const result = await ctx.mcpReq.elicitInput({
        mode: "form",
        message: "Testbed form (legacy era): tell me about yourself",
        requestedSchema: {
          type: "object",
          properties: {
            name: { type: "string", title: "Name" },
            favouriteColour: {
              type: "string",
              title: "Favourite colour",
              enum: ["red", "green", "blue", "teal"],
            },
            age: { type: "integer", minimum: 0, maximum: 150 },
            subscribe: { type: "boolean", default: false },
          },
          required: ["name", "favouriteColour"],
        },
      });
      return text({ era: "legacy", ...result });
    },
  );

  server.registerTool(
    "elicit_confirm",
    {
      description:
        "Ask a single yes/no confirmation. Reports accept, decline, or cancel.",
      inputSchema: z.object({
        message: z.string().default("Proceed with the testbed action?"),
      }),
    },
    async ({ message }, ctx) => {
      const schema = z.object({ confirm: z.boolean() });
      if (era() === "modern") {
        const view = inputResponse(ctx.mcpReq.inputResponses, "confirm");
        if (view.kind === "elicit") {
          return text({
            era: "modern",
            action: view.action,
            content: view.content,
          });
        }
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({ message, requestedSchema: schema }),
          },
        });
      }
      const result = await ctx.mcpReq.elicitInput({
        mode: "form",
        message,
        requestedSchema: {
          type: "object",
          properties: { confirm: { type: "boolean", title: "Confirm" } },
          required: ["confirm"],
        },
      });
      return text({ era: "legacy", ...result });
    },
  );

  server.registerTool(
    "elicit_url",
    {
      description:
        "Ask the user to open a URL (URL-mode elicitation). On the 2025 era, optionally sends `notifications/elicitation/complete` after `complete_after_seconds`.",
      inputSchema: z.object({
        url: z.string().url().default("https://modelcontextprotocol.io/"),
        complete_after_seconds: z
          .number()
          .int()
          .min(0)
          .max(300)
          .default(0)
          .describe("Legacy era only: 0 disables the completion notification"),
      }),
    },
    async ({ url, complete_after_seconds }, ctx) => {
      if (era() === "modern") {
        const view = inputResponse(ctx.mcpReq.inputResponses, "open_url");
        if (view.kind === "elicit") {
          return text({ era: "modern", action: view.action });
        }
        return inputRequired({
          inputRequests: {
            open_url: inputRequired.elicitUrl({
              message: "Testbed: please open this page",
              url,
            }),
          },
        });
      }
      const elicitationId = randomUUID();
      if (complete_after_seconds > 0) {
        const notify =
          server.server.createElicitationCompletionNotifier(elicitationId);
        setTimeout(() => {
          notify().catch((error) =>
            debug("elicitation complete notify failed:", error?.message),
          );
        }, complete_after_seconds * 1000);
      }
      const result = await ctx.mcpReq.elicitInput({
        mode: "url",
        message: "Testbed (legacy era): please open this page",
        url,
        elicitationId,
      });
      return text({ era: "legacy", elicitationId, ...result });
    },
  );

  // ---- Dynamic tools (list changed) ----------------------------------------

  const dynamicTools = new Map();

  server.registerTool(
    "tools_add",
    {
      description:
        "Register a new tool named `dynamic_<suffix>` and send tools/list_changed.",
      inputSchema: z.object({
        suffix: z
          .string()
          .regex(/^[a-z0-9_]{1,32}$/)
          .default("one"),
      }),
    },
    async ({ suffix }) => {
      const name = `dynamic_${suffix}`;
      if (dynamicTools.has(name)) return text(`${name} already exists`);
      const registered = server.registerTool(
        name,
        {
          description: `Dynamically added testbed tool (${suffix}).`,
          inputSchema: z.object({}),
        },
        async () => text(`${name} called`),
      );
      dynamicTools.set(name, registered);
      // registerTool already notifies when connected; send again explicitly
      // so the smoke test does not depend on that SDK detail.
      server.sendToolListChanged();
      return text(`added ${name}; tools/list_changed sent`);
    },
  );

  server.registerTool(
    "tools_remove",
    {
      description:
        "Remove a tool added by tools_add and send tools/list_changed.",
      inputSchema: z.object({ name: z.string() }),
    },
    async ({ name }) => {
      const registered = dynamicTools.get(name);
      if (!registered) {
        return text(
          `unknown dynamic tool ${name}; known: ${[...dynamicTools.keys()].join(", ") || "(none)"}`,
        );
      }
      registered.remove();
      dynamicTools.delete(name);
      server.sendToolListChanged();
      return text(`removed ${name}; tools/list_changed sent`);
    },
  );

  server.registerTool(
    "tools_toggle_echo",
    {
      description:
        "Disable or re-enable the `echo` tool and send tools/list_changed.",
      inputSchema: z.object({ enabled: z.boolean() }),
    },
    async ({ enabled }) => {
      if (enabled) echoTool.enable();
      else echoTool.disable();
      server.sendToolListChanged();
      return text(`echo ${enabled ? "enabled" : "disabled"}`);
    },
  );

  // ---- Resources -----------------------------------------------------------

  let tick = 0;
  const clockUri = "testbed://clock";
  server.registerResource(
    "clock",
    clockUri,
    {
      title: "Testbed clock",
      description: `Updates every ${TICK_MS} ms. Subscribe to see resources/updated notifications.`,
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ tick, now: new Date().toISOString() }),
        },
      ],
    }),
  );

  server.registerResource(
    "mailbox-snapshot",
    "testbed://mailbox",
    {
      title: "Testbed mailbox",
      description: "Current contents of the shared mailbox file.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(readMailbox(), null, 2),
        },
      ],
    }),
  );

  const subscriptions = new Set();
  try {
    server.server.setRequestHandler("resources/subscribe", async (request) => {
      subscriptions.add(request.params.uri);
      debug("subscribed", request.params.uri);
      return {};
    });
    server.server.setRequestHandler(
      "resources/unsubscribe",
      async (request) => {
        subscriptions.delete(request.params.uri);
        debug("unsubscribed", request.params.uri);
        return {};
      },
    );
  } catch (error) {
    debug("subscribe handlers unavailable:", error?.message ?? error);
  }

  const timer = setInterval(() => {
    tick += 1;
    if (!server.isConnected()) return;
    if (subscriptions.has(clockUri)) {
      server.server
        .sendResourceUpdated({ uri: clockUri })
        .catch((error) => debug("resources/updated failed:", error?.message));
    }
  }, TICK_MS);
  timer.unref();

  const dynamicResources = new Map();
  server.registerTool(
    "resource_add",
    {
      description:
        "Register a static resource `testbed://note/<name>` and send resources/list_changed.",
      inputSchema: z.object({
        name: z.string().regex(/^[a-z0-9_-]{1,32}$/),
        body: z.string().default("hello from the testbed"),
      }),
    },
    async ({ name, body }) => {
      const uri = `testbed://note/${name}`;
      dynamicResources.get(uri)?.remove();
      dynamicResources.set(
        uri,
        server.registerResource(
          `note-${name}`,
          uri,
          { title: `Note ${name}`, mimeType: "text/plain" },
          async (u) => ({
            contents: [{ uri: u.href, mimeType: "text/plain", text: body }],
          }),
        ),
      );
      server.sendResourceListChanged();
      return text(`registered ${uri}; resources/list_changed sent`);
    },
  );

  server.registerTool(
    "resource_touch_clock",
    {
      description:
        "Advance the clock and send resources/updated for testbed://clock now, whether or not the client subscribed.",
      inputSchema: z.object({}),
    },
    async () => {
      tick += 1;
      const status = await safeNotify("resources/updated", () =>
        server.server.sendResourceUpdated({ uri: clockUri }),
      );
      return text({
        tick,
        subscribed: subscriptions.has(clockUri),
        status,
      });
    },
  );

  // ---- Logging -------------------------------------------------------------

  server.registerTool(
    "log_levels",
    {
      description:
        "Send one notifications/message log entry at every level (debug to emergency). Deprecated in 2026-07-28 but still functional.",
      inputSchema: z.object({
        text: z.string().default("testbed log entry"),
      }),
    },
    async ({ text: value }, ctx) => {
      const results = [];
      for (const level of LOG_LEVELS) {
        results.push(
          await safeNotify(level, () =>
            ctx.mcpReq.log(level, { message: value, level }, "testbed"),
          ),
        );
      }
      return text(results);
    },
  );

  // ---- Mailbox (pull-only agent messaging experiment) ----------------------
  //
  // Identity is SELF-DECLARED: callers pass their own name. MCP gives the
  // server no trusted per-session identity, so any caller can claim any name.

  server.registerTool(
    "mailbox_register",
    {
      description:
        "Register (or refresh) this agent in the shared mailbox under a short name, with an optional one-line task summary. Identity is self-declared.",
      inputSchema: z.object({
        name: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
        task: z.string().max(200).optional(),
      }),
    },
    async ({ name, task }) => {
      const entry = updateMailbox((mailbox) => {
        mailbox.sessions[name] = {
          name,
          task: task ?? mailbox.sessions[name]?.task ?? "",
          pid: process.pid,
          lastSeen: new Date().toISOString(),
        };
        return mailbox.sessions[name];
      });
      return text({ registered: entry, mailboxFile: MAILBOX_FILE });
    },
  );

  server.registerTool(
    "mailbox_list_sessions",
    {
      description:
        "List registered agents with their task summary, last-seen time, and unread count.",
      inputSchema: z.object({}),
    },
    async () => {
      const mailbox = readMailbox();
      return text(
        Object.values(mailbox.sessions).map((s) => ({
          ...s,
          unread: unreadFor(mailbox, s.name).length,
        })),
      );
    },
  );

  server.registerTool(
    "mailbox_send",
    {
      description:
        "Send a message to another registered agent. Pull-only: the recipient sees it only when it calls mailbox_read.",
      inputSchema: z.object({
        from: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
        to: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
        text: z.string().min(1).max(4000),
        reply_to: z.string().optional(),
      }),
    },
    async ({ from, to, text: body, reply_to }) => {
      const result = updateMailbox((mailbox) => {
        if (!mailbox.sessions[to]) {
          return { error: `unknown recipient ${to}` };
        }
        const message = {
          id: randomUUID(),
          from,
          to,
          text: body,
          replyTo: reply_to ?? null,
          sentAt: new Date().toISOString(),
          readAt: null,
        };
        mailbox.messages.push(message);
        if (mailbox.messages.length > 500) {
          mailbox.messages.splice(0, mailbox.messages.length - 500);
        }
        return { queued: message.id, status: "queued (not read)" };
      });
      return text(result);
    },
  );

  server.registerTool(
    "mailbox_read",
    {
      description:
        "Read unread messages addressed to `name` and mark them read. Optionally wait up to `wait_seconds` for one to arrive.",
      inputSchema: z.object({
        name: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
        wait_seconds: z.number().int().min(0).max(60).default(0),
        peek: z.boolean().default(false).describe("Do not mark messages read"),
      }),
    },
    async ({ name, wait_seconds, peek }, ctx) => {
      const deadline = Date.now() + wait_seconds * 1000;
      for (;;) {
        const pending = unreadFor(readMailbox(), name);
        if (pending.length > 0 || Date.now() >= deadline) break;
        try {
          await sleep(500, ctx.mcpReq.signal);
        } catch {
          return text({ messages: [], status: "cancelled while waiting" });
        }
      }
      const messages = peek
        ? unreadFor(readMailbox(), name)
        : updateMailbox((mailbox) => {
            const now = new Date().toISOString();
            const unread = unreadFor(mailbox, name);
            for (const m of unread) m.readAt = now;
            if (mailbox.sessions[name]) mailbox.sessions[name].lastSeen = now;
            return unread;
          });
      return text({ messages, count: messages.length });
    },
  );

  server.registerTool(
    "mailbox_push_stub",
    {
      description:
        "STUB for push delivery. Sends the text as notifications the client may ignore: a log message, resources/updated for testbed://mailbox, and a non-standard `notifications/claude/channel`. Reports which sends succeeded; it does not prove the model saw anything.",
      inputSchema: z.object({
        text: z.string().min(1).max(2000),
      }),
    },
    async ({ text: body }, ctx) => {
      const results = [
        await safeNotify("notifications/message", () =>
          ctx.mcpReq.log("notice", { push: body }, "testbed-mailbox"),
        ),
        await safeNotify("resources/updated testbed://mailbox", () =>
          server.server.sendResourceUpdated({ uri: "testbed://mailbox" }),
        ),
        await safeNotify("notifications/claude/channel", () =>
          ctx.mcpReq.notify({
            method: "notifications/claude/channel",
            params: { content: body, meta: { source: "agentlink-testbed" } },
          }),
        ),
      ];
      return text(results);
    },
  );

  const originalClose = server.close.bind(server);
  server.close = async () => {
    clearInterval(timer);
    return originalClose();
  };

  return server;
}

debug(
  `starting (era=${process.env.TESTBED_ERA ?? "both"}, mailbox=${MAILBOX_FILE})`,
);
if (process.env.TESTBED_ERA === "legacy") {
  await createServer().connect(new StdioServerTransport());
} else {
  serveStdio(createServer);
}
