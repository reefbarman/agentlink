# Agent Skills Specification Notes

Distilled from https://agentskills.io/specification.

## Directory structure

A skill is a directory containing at minimum a `SKILL.md` file:

```text
skill-name/
├── SKILL.md       # Required: metadata + instructions
├── scripts/       # Optional executable code
├── references/    # Optional documentation loaded on demand
├── assets/        # Optional templates/resources
└── ...
```

## SKILL.md format

`SKILL.md` must contain YAML frontmatter followed by Markdown content.

Required frontmatter:

| Field         | Constraints                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | Max 64 chars; lowercase letters, numbers, and hyphens only; must not start/end with hyphen; must not contain consecutive hyphens; must match parent directory name. |
| `description` | Max 1024 chars; non-empty; describes what the skill does and when to use it.                                                                                        |

Optional frontmatter:

| Field           | Notes                                                                            |
| --------------- | -------------------------------------------------------------------------------- |
| `license`       | License name or reference to bundled license file.                               |
| `compatibility` | Max 500 chars; environment requirements if any.                                  |
| `metadata`      | Arbitrary key-value mapping for client-specific metadata.                        |
| `allowed-tools` | Space-separated string of pre-approved tools; experimental and client-dependent. |

## Name rules

Valid:

```yaml
name: pdf-processing
name: data-analysis
name: code-review
```

Invalid:

```yaml
name: PDF-Processing  # uppercase not allowed
name: -pdf            # cannot start with hyphen
name: pdf--processing # consecutive hyphens not allowed
```

## Description rules

The description should include both:

1. What the skill does.
2. When the agent should use it.

Good:

```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents or when the user mentions PDFs, forms, or document extraction.
```

Poor:

```yaml
description: Helps with PDFs.
```

## Progressive disclosure

Skills should minimize prompt cost:

- Startup loads only metadata (`name`, `description`) for all skills.
- Full `SKILL.md` body is loaded only when activated.
- Additional `references/`, `scripts/`, and `assets/` are loaded only when needed.

Guidelines:

- Keep main `SKILL.md` under 500 lines and preferably under 5,000 tokens.
- Move detailed reference material to focused files in `references/`.
- Keep references one level deep from `SKILL.md`.
- Avoid chains of nested references.

## Optional directories

`scripts/`:

- Self-contained executable helpers.
- Clear dependencies and helpful error messages.
- Handle edge cases gracefully.

`references/`:

- Detailed technical references.
- Domain-specific docs or structured forms.
- Load only when needed.

`assets/`:

- Templates, images, static data, schemas, lookup tables.

## Validation

The official reference validator is:

```bash
skills-ref validate ./my-skill
```

AgentLink does not currently bundle this validator, so use the checklist in `SKILL.md` and keep frontmatter compatible with AgentLink's parser.
