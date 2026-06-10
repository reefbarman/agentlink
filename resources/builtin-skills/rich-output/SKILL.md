---
name: rich-output
description: Use focused Markdown, Mermaid diagrams, and Vega/Vega-Lite charts for architecture, workflows, relationships, or quantitative explanations when rich rendering clarifies the answer.
---

# Rich Output

Use this skill when the response would be clearer with structured Markdown, a diagram, or a chart.

## Rendering options

AgentLink responses are rendered in a rich Markdown view that supports:

- GitHub-flavored Markdown for headings, lists, tables, code fences, and task lists.
- Mermaid for architecture, data flow, schemas, relationships, and workflows.
- Vega/Vega-Lite for quantitative comparisons, trends over time, distributions, and other data visualizations.

## When to use visuals

Use rich output proactively when it reduces explanation burden or makes structure obvious:

- Architecture or component relationships → Mermaid.
- Request/response, state, approval, or deployment flow → Mermaid.
- Schema/entity relationships → Mermaid.
- Metrics, comparisons, token/cost breakdowns, trends, or distributions → Vega/Vega-Lite.
- Small matrices or trade-off summaries → Markdown tables.

Do not add visuals just to decorate a simple answer.

## Diagram guidance

Prefer Mermaid for conceptual structure. Keep diagrams focused:

- Show the relevant subset, usually 5-10 key elements.
- Use clear labels that match code or product terminology.
- Avoid giant diagrams with every file, module, or branch.
- Put a one-sentence explanation before or after the diagram so the takeaway is clear.

## Chart guidance

Prefer Vega/Vega-Lite when numbers are easier to compare visually than in prose.

- Include only the data needed for the point being made.
- Choose simple encodings: bar charts for comparisons, line charts for trends, histograms for distributions.
- Label axes and units clearly.
- Do not invent data; if values are estimates, label them as estimates.

## Validation checklist

Before finalizing a rich response:

1. Confirm the visual directly answers the user's question.
2. Confirm it is smaller and clearer than the prose it replaces.
3. Confirm any data shown is sourced from the workspace, tool output, or explicitly marked as illustrative/estimated.
