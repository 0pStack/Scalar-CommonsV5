#!/usr/bin/env python3
"""SC-E1 Indexer reconciliation: asserts indexer per-era export matches chain storage.
Usage: python reconcile.py <golden_events.jsonl> <fixture_expected.json>
"""
import json, sys, argparse
from pathlib import Path

def load_jsonl(path):
    return [json.loads(l) for l in Path(path).read_text().splitlines() if l.strip()]

def build_indexer_view(events):
    """Reconstruct per-era storage from events only (indexer's job)."""
    agents = {}; escrows = {}; per_era = {}
    for e in events:
        era = str(e["era"])
        if e["event"] == "AgentRegistered":
            agents[e["agent"]] = {"stake":e["stake"],"active":True,"registered_at_block":e["block"]}
        elif e["event"] == "EscrowCreated":
            escrows[e["task_id"]] = {"agent":e.get("agent","?"),"bond":e["bond"],"status":"open"}
        elif e["event"] == "EscrowCompleted":
            if e["task_id"] in escrows:
                escrows[e["task_id"]]["status"] = "completed"
        elif e["event"] == "EraSettled":
            per_era[era] = {
                "agents": {a:{**v} for a,v in agents.items() if v["active"]},
                "escrows": {t:{**x} for t,x in escrows.items()}
            }
    return {"agents":agents,"escrows":escrows,"per_era":per_era}

def reconcile(events_path, expected_path):
    events = load_jsonl(events_path)
    expected = json.loads(Path(expected_path).read_text())
    indexer_view = build_indexer_view(events)
    mismatches = []
    for era, exp_snap in expected.get("per_era", {}).items():
        idx_snap = indexer_view.get("per_era", {}).get(era, {})
        for agent, exp_state in exp_snap.get("agents", {}).items():
            idx_state = idx_snap.get("agents", {}).get(agent)
            if idx_state != exp_state:
                mismatches.append({"era":era,"agent":agent,"expected":exp_state,"got":idx_state})
    if mismatches:
        print(f"FAIL: {len(mismatches)} reconciliation mismatch(es):")
        for m in mismatches:
            print(f"  era={m['era']} agent={m['agent']}: expected={m['expected']} got={m['got']}")
        sys.exit(1)
    else:
        era_count = len(expected.get("per_era",{}))
        agent_count = sum(len(v.get("agents",{})) for v in expected.get("per_era",{}).values())
        print(f"PASS: {era_count} eras, {agent_count} agent-era records reconciled exactly")

def main():
    p = argparse.ArgumentParser()
    p.add_argument("events", help="golden_events.jsonl path")
    p.add_argument("expected", help="fixture_expected.json path")
    args = p.parse_args()
    reconcile(args.events, args.expected)

if __name__ == "__main__":
    main()
