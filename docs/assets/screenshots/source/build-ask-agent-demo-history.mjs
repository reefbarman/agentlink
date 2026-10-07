#!/usr/bin/env node

// Builds the mock Ask Agent history used for Desktop marketing screenshots.
// Timestamps are relative to "now" so the sidebar shows realistic recency.
// Usage: node build-ask-agent-demo-history.mjs <output.json>
import { writeFileSync } from "node:fs";

const output = process.argv[2];
if (!output) {
  console.error("usage: build-ask-agent-demo-history.mjs <output.json>");
  process.exit(1);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = Date.now();
const PREFIX = "browser-gateway:ask-agent:demo-";

let toolSeq = 0;
const tool = (name, input, result, durationMs) => ({
  type: "tool_call",
  id: `demo-tool-${++toolSeq}`,
  name,
  inputJson: JSON.stringify(input),
  result,
  complete: true,
  durationMs,
});
const text = (value) => ({ type: "text", text: value });

function session(slug, title, startedAgo, turns) {
  const id = `${PREFIX}${slug}`;
  const createdAt = now - startedAgo;
  const messages = [];
  let at = createdAt;
  turns.forEach(([prompt, blocks], index) => {
    messages.push({
      id: `demo-${slug}-user-${index + 1}`,
      role: "user",
      content: prompt,
      timestamp: at,
      blocks: [text(prompt)],
    });
    at += 40_000;
    messages.push({
      id: `demo-${slug}-assistant-${index + 1}`,
      role: "assistant",
      content: "",
      timestamp: at,
      blocks,
    });
    at += 3 * MINUTE;
  });
  return {
    id,
    title,
    createdAt,
    lastActiveAt: at - 3 * MINUTE,
    messages,
    nextMessageSequence: messages.length + 1,
  };
}

const webhookAnswer = `Short version: retry with **exponential backoff plus full jitter**, cap the delay, and make the handler idempotent so a retry can never double-charge or double-email.

### Recommended schedule

| Attempt | Base delay | With full jitter |
| ------- | ---------- | ---------------- |
| 1 | 1 s | 0 – 1 s |
| 2 | 2 s | 0 – 2 s |
| 3 | 4 s | 0 – 4 s |
| 4 | 8 s | 0 – 8 s |
| 5 | 16 s | 0 – 16 s |
| 6+ | capped at 5 min | 0 – 5 min |

Full jitter spreads retries out so a burst of failures doesn't turn into a synchronized retry storm against the receiving service.

### A small TypeScript helper

\`\`\`ts
export async function withBackoff<T>(
  send: () => Promise<T>,
  { maxAttempts = 6, baseMs = 1_000, capMs = 300_000 } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryable(error)) throw error;
      const ceiling = Math.min(capMs, baseMs * 2 ** (attempt - 1));
      await sleep(Math.random() * ceiling);
    }
  }
}
\`\`\`

### What to retry

- **Retry:** network errors, timeouts, \`429\`, and \`5xx\` responses. Honour \`Retry-After\` when the receiver sends it.
- **Don't retry:** \`400\`, \`401\`, \`403\`, \`404\`, \`410\`. Those won't fix themselves.
- **Always send** a stable \`Idempotency-Key\` header (the event ID works well) so the receiver can dedupe.

### Delivery flow

\`\`\`mermaid
flowchart LR
  E[Invoice paid] --> Q[(Delivery queue)]
  Q --> S{Send webhook}
  S -- 2xx --> D[Mark delivered]
  S -- 429 / 5xx --> B[Backoff + jitter] --> Q
  S -- 4xx --> F[Dead letter + alert]
\`\`\`

After the final attempt, move the event to a dead-letter table and surface it in the dashboard so someone can replay it manually.`;

const followUpAnswer = `Yes. Keep the queue durable rather than retrying in-process, otherwise a deploy or crash drops every pending retry.

A simple Postgres-backed approach is enough at your scale:

1. Insert a row into \`webhook_deliveries\` with \`next_attempt_at = now()\`.
2. A worker polls with \`SELECT … FOR UPDATE SKIP LOCKED\` where \`next_attempt_at <= now()\`.
3. On failure, bump \`attempt\` and set \`next_attempt_at\` using the jittered delay above.
4. After 6 attempts, set \`status = 'dead'\` and notify.

\`SKIP LOCKED\` lets you run several workers without them fighting over the same row.`;

const sessions = [
  session(
    "webhook-retries",
    "Webhook retries with exponential backoff",
    25 * MINUTE,
    [
      [
        "What's the best way to retry failed outgoing webhooks? We send invoice.paid events to customer endpoints and some of them flake.",
        [
          tool(
            "web_search",
            { query: "webhook retry exponential backoff jitter best practice" },
            "Found 8 results: AWS Architecture Blog, Exponential Backoff And Jitter; Stripe Docs, Webhook retries; Svix, Webhook retry best practices; …",
            1840,
          ),
          tool(
            "web_fetch",
            {
              url: "https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/",
            },
            "Exponential Backoff And Jitter. Compares no jitter, full jitter, equal jitter, and decorrelated jitter …",
            920,
          ),
          text(webhookAnswer),
        ],
      ],
      [
        "Should the retries live in a queue or is in-process fine for now?",
        [text(followUpAnswer)],
      ],
    ],
  ),
  session(
    "tailwind-container-queries",
    "Tailwind container queries for the invoice table",
    3 * HOUR,
    [
      [
        "Can I make the invoices table switch to cards based on its container width instead of the viewport?",
        [
          text(
            'Yes. Tailwind v3.2+ supports container queries through the official `@tailwindcss/container-queries` plugin.\n\nMark the wrapper with `@container`, then use `@md:` style variants on children:\n\n```tsx\n<div className="@container">\n  <div className="grid @md:hidden">{/* cards */}</div>\n  <table className="hidden @md:table">{/* rows */}</table>\n</div>\n```\n\nThis keeps the table responsive when it\'s rendered inside a narrow sidebar layout, not just on small screens.',
          ),
        ],
      ],
    ],
  ),
  session(
    "postgres-index",
    "Index for invoices by customer and date",
    6 * HOUR,
    [
      [
        "Which index should I add for `WHERE customer_id = $1 ORDER BY date DESC LIMIT 20`?",
        [
          text(
            "A composite index matching the filter and the sort order:\n\n```sql\nCREATE INDEX CONCURRENTLY invoices_customer_date_idx\n  ON invoices (customer_id, date DESC);\n```\n\nPostgres can then read the first 20 matching rows straight from the index without a separate sort step. Use `CONCURRENTLY` so the table isn't locked while it builds.",
          ),
        ],
      ],
    ],
  ),
  session(
    "server-actions-validation",
    "Validating server actions with Zod",
    1 * DAY + 2 * HOUR,
    [
      [
        "How should I return field errors from a Next.js server action?",
        [
          text(
            "Parse with `safeParse`, and return `error.flatten().fieldErrors` as part of a state object that `useActionState` reads. That keeps validation on the server and lets the form render inline messages without throwing.",
          ),
        ],
      ],
    ],
  ),
  session(
    "currency-formatting",
    "Formatting cents as currency",
    1 * DAY + 7 * HOUR,
    [
      [
        "Best way to format amounts stored in cents?",
        [
          text(
            "Divide by 100 and use `Intl.NumberFormat`:\n\n```ts\nnew Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })\n  .format(amountInCents / 100);\n```\n\nCreate the formatter once and reuse it; constructing it per row is surprisingly expensive in long tables.",
          ),
        ],
      ],
    ],
  ),
  session("csv-export", "Streaming a CSV export", 2 * DAY + 4 * HOUR, [
    [
      "How do I stream a large CSV download from a route handler?",
      [
        text(
          'Return a `Response` wrapping a `ReadableStream` and write rows in batches as you page through the query. Set `Content-Type: text/csv` and `Content-Disposition: attachment; filename="invoices.csv"` so the browser downloads it.',
        ),
      ],
    ],
  ]),
  session("auth-session-length", "Session length for NextAuth", 4 * DAY, [
    [
      "What's a sensible session lifetime for an internal billing dashboard?",
      [
        text(
          "For a finance tool, 8 hours with sliding renewal is a reasonable default: long enough for a work day, short enough that a forgotten laptop isn't open indefinitely. Require re-authentication for sensitive actions like changing payout details.",
        ),
      ],
    ],
  ]),
  session("release-notes", "Drafting release notes", 6 * DAY, [
    [
      "Turn these merged PR titles into short customer-facing release notes.",
      [
        text(
          "**New**\n- Overdue badges on invoices older than 30 days\n- CSV export for the invoices list\n\n**Improved**\n- Faster customer search\n- Invoice table now adapts to narrow layouts",
        ),
      ],
    ],
  ]),
];

const history = { activeSessionId: sessions[0].id, sessions };
writeFileSync(output, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600 });
console.log(`wrote ${sessions.length} demo sessions to ${output}`);
