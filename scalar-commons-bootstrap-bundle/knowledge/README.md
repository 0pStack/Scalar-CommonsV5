# Scalar Commons Knowledge Graph

Shared state for parallel agent sessions. Agents coordinate through this
graph, not through conversation. Maintained by the `kg-updater` subagent.

## Files
- `entities.jsonl` — one JSON object per line: {id, type, name, ...attrs, date, source}
- `relations.jsonl` — one per line: {from, to, rel, date, source}

## Conventions (enforced by kg-updater)
- APPEND ONLY. Corrections are new entries + a `supersedes` relation.
- Stable slugs: `finding:R-SC-0004`, `decision:OD-4`, `pallet:emissions`,
  `artifact:<path>`, `gate:P0-1`, `person:<name>`.
- Every entry carries `date` and `source` (PR/issue number or file path).
- Grep for the slug before adding; if it exists, add only the new relation.

## Entity types in use
project, pallet, component, artifact, finding, decision, gate, prediction,
person, concept

## Wiring the live KG memory server (when Neo4j Aura / KG MCP is stood up)
Add to `.mcp.json` (and the same URL as a custom connector in claude.ai and
Cowork so all surfaces share one brain):

    "kg-memory": { "type": "http", "url": "<KG_SERVER_URL>" }

Until then, this directory IS the graph; the JSONL files are the load format
for the server when it comes online.
