# Scalar Commons Knowledge Graph

Shared state for parallel agent sessions. Agents coordinate through this
graph, not through conversation. Maintained by the `kg-updater` subagent.

## Files

- `entities.jsonl` — one JSON object per line: `{"id":"...","name":"...","type":"...","description":"..."}`
- `relations.jsonl` — one JSON object per line: `{"from_id":"...","relation":"...","to_id":"...","note":"..."}`

## Entity schema

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Stable kebab-case slug (e.g. `pallet-emissions`, `R-SC-0004`, `OD-2`) |
| `name` | yes | Human-readable display name |
| `type` | yes | One of: `pallet`, `artifact`, `finding`, `open_decision`, `experiment` |
| `description` | yes | One-sentence summary of the entity |

## Relation schema

| Field | Required | Description |
|-------|----------|-------------|
| `from_id` | yes | `id` of the source entity |
| `relation` | yes | Verb describing the edge (e.g. `depends_on`, `governs`, `references`, `produces`, `follows_from`, `implements`, `documents`) |
| `to_id` | yes | `id` of the target entity |
| `note` | yes | One-sentence explanation of why this edge exists |

## Naming rules

- **IDs are kebab-case** — no colons, underscores, or spaces. Use `pallet-agents`, not `pallet:agents`.
- **Type values:** `pallet` | `artifact` | `finding` | `open_decision` | `experiment`
- **Finding IDs** match the report slug: `R-SC-0001`, `R-SC-0002`, etc.
- **Open-decision IDs** match the decision slug: `OD-1`, `OD-2`, etc.

## How to add entities

1. **Check for duplicates first:** `grep '"id":"<your-id>"' knowledge/entities.jsonl`
2. If the id does not exist, append a new JSON line to `entities.jsonl`.
3. Never modify or delete existing lines — the graph is append-only.

## How to add relations

1. **Check for duplicates first:** `grep '"from_id":"<src>","relation":"<rel>","to_id":"<dst>"' knowledge/relations.jsonl`
2. If the edge does not exist, append a new JSON line to `relations.jsonl`.
3. Both `from_id` and `to_id` must already exist in `entities.jsonl`.

## How to avoid duplicates

- Grep for the `id` before appending an entity.
- Grep for the `(from_id, relation, to_id)` triple before appending a relation.
- If an entity's description changes, do NOT edit the old line; append a new entity line with a revised description and add a `supersedes` relation pointing from new to old.

## kg-updater agent conventions

- The `kg-updater` subagent is invoked proactively at the end of any completed issue, merged PR, experiment run, or design decision.
- It appends entities and relations; it never rewrites history and never touches code.
- Every PR that closes an issue with new findings or decisions should include a `kg-updater` run as its final step.
- When running `kg-updater`, pass the relevant finding/decision IDs and file paths as context so the agent can produce well-formed entries without re-reading the entire codebase.
