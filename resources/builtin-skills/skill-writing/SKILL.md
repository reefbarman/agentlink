---
name: skill-writing
description: Write, review, and validate Agent Skills. Use when creating or editing SKILL.md files, .agentlink/skills directories, or reusable agent workflows that should follow the agentskills.io specification.
---

# Skill Writing

Use this skill when authoring or reviewing an Agent Skill for AgentLink.

## Required structure

A skill is a directory containing a `SKILL.md` file:

```text
skill-name/
├── SKILL.md
├── scripts/      # optional executable helpers
├── references/   # optional detailed docs loaded on demand
└── assets/       # optional templates/static resources
```

`SKILL.md` must start with YAML frontmatter followed by Markdown instructions.

## AgentLink parser constraints

The agentskills.io spec allows YAML, but AgentLink currently parses frontmatter with a simple single-line `key: value` parser. To ensure the skill loads correctly in AgentLink:

- Keep every frontmatter field on one line.
- Do not use multi-line YAML strings (`|`, `>`, folded blocks) in `description`.
- Put detailed guidance in the Markdown body or `references/`, not frontmatter.

## Frontmatter checklist

Required:

- `name`: 1-64 chars; lowercase letters, numbers, and hyphens only; no leading/trailing hyphen; no consecutive hyphens; must match the parent directory name.
- `description`: 1-1024 chars; explain **what the skill does** and **when to use it**; include specific keywords users or agents may mention.

Optional:

- `license`: short license name or bundled license filename.
- `compatibility`: only if the skill has environment requirements; max 500 chars.
- `metadata`: arbitrary key-value map in the official spec, but avoid it for AgentLink until the parser supports nested YAML.
- `allowed-tools`: space-separated tool allowlist; experimental and client-dependent.

Good description:

```yaml
description: Extract text and tables from PDF files, fill PDF forms, and merge PDFs. Use when working with PDFs, forms, document extraction, or PDF automation.
```

Poor description:

```yaml
description: Helps with PDFs.
```

## Body guidance

Keep `SKILL.md` focused and progressively disclosed:

- Recommended under 500 lines / 5,000 tokens.
- Put only activation-critical instructions in the main file.
- Move detailed references to `references/REFERENCE.md` or focused one-level reference files.
- Put reusable scripts in `scripts/` and static templates/data in `assets/`.
- Reference files with paths relative to the skill root, e.g. `references/spec.md`.
- Avoid deep reference chains.

Useful sections:

1. When to use this skill
2. Step-by-step workflow
3. Inputs/outputs or templates
4. Validation checklist
5. Common edge cases

## Validation before proposing a skill

Before writing or proposing a skill:

1. Verify the directory name and frontmatter `name` match.
2. Verify `name` obeys the lowercase hyphenated slug rules.
3. Verify `description` is one line, keyword-rich, and explains both what and when.
4. Keep frontmatter simple enough for AgentLink's parser.
5. Keep the main body concise; move detail to `references/`.
6. Prefer examples and checklists over vague prose.
7. If this is persistent memory/workflow creation, propose it through the approved memory flow rather than writing directly.

See `references/spec.md` for the distilled agentskills.io specification.
