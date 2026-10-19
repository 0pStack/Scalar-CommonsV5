#!/usr/bin/env python3
"""SC-E1 P0-5: Deterministic indexer reconciliation fixture.
Generates a golden event stream + chain-storage snapshot without a live node.
"""
import json, hashlib
from pathlib import Path

# Deterministic extrinsic sequence
SEQUENCE = [
    {"era":1,"block":1,"extrinsic":"register_agent","agent":"alice","stake":10000},
    {"era":1,"block":2,"extrinsic":"register_agent","agent":"bob","stake":5000},
    {"era":1,"block":3,"extrinsic":"create_escrow","agent":"alice","task_id":"t1","bond":500},
    {"era":1,"block":4,"extrinsic":"complete_escrow","task_id":"t1","result":"success"},
    {"era":1,"block":5,"extrinsic":"settle_era","era":1},
    {"era":2,"block":6,"extrinsic":"register_agent","agent":"carol","stake":8000},
    {"era":2,"block":7,"extrinsic":"settle_era","era":2},
]

def apply_sequence(seq):
    """Apply extrinsic sequence; return (event_stream, chain_storage_snapshot)."""
    agents = {}
    escrows = {}
    events = []
    per_era = {}
    for tx in seq:
        era = tx["era"]; block = tx["block"]; xt = tx["extrinsic"]
        if xt == "register_agent":
            agents[tx["agent"]] = {"stake": tx["stake"], "active": True, "registered_at_block": block}
            events.append({"block":block,"era":era,"event":"AgentRegistered","agent":tx["agent"],"stake":tx["stake"]})
        elif xt == "create_escrow":
            escrows[tx["task_id"]] = {"agent":tx["agent"],"bond":tx["bond"],"status":"open"}
            events.append({"block":block,"era":era,"event":"EscrowCreated","task_id":tx["task_id"],"bond":tx["bond"]})
        elif xt == "complete_escrow":
            if tx["task_id"] in escrows:
                escrows[tx["task_id"]]["status"] = "completed"
            events.append({"block":block,"era":era,"event":"EscrowCompleted","task_id":tx["task_id"],"result":tx["result"]})
        elif xt == "settle_era":
            snapshot = {a: {**v} for a, v in agents.items() if v["active"]}
            per_era[str(era)] = {"agents": snapshot, "escrows": {t: {**e} for t,e in escrows.items()}}
            events.append({"block":block,"era":era,"event":"EraSettled","agent_count":len(snapshot)})
    storage = {"agents": agents, "escrows": escrows, "per_era": per_era}
    return events, storage

def main():
    events, storage = apply_sequence(SEQUENCE)
    out = Path(__file__).parent
    (out / "golden_events.jsonl").write_text("\n".join(json.dumps(e) for e in events))
    (out / "fixture_expected.json").write_text(json.dumps(storage, indent=2))
    chk = hashlib.sha256(json.dumps(storage, sort_keys=True).encode()).hexdigest()[:16]
    (out / "fixture_checksum.txt").write_text(chk)
    print(f"Generated {len(events)} events, {len(storage['agents'])} agents, checksum={chk}")
    return events, storage

if __name__ == "__main__":
    main()
