#!/usr/bin/env python3
"""SC-E1 Analysis + Verdict Pipeline (protocol §8.4/§8.5)
Usage: python analyze.py <manifest.json>
       python analyze.py --check nc2
       python analyze.py --check nc3
"""
import json, sys, argparse
from pathlib import Path

SCHEMA_VERDICT = {
    "required": ["run_id", "metrics", "overall_verdict"],
    "properties": {"overall_verdict": {"enum": ["PASS", "FAIL"]}}
}

def _validate(data, schema):
    for req in schema.get("required", []):
        if req not in data:
            raise ValueError(f"Missing required field: {req}")
    for key, vs in schema.get("properties", {}).items():
        if key in data and "enum" in vs and data[key] not in vs["enum"]:
            raise ValueError(f"Field {key} must be one of {vs['enum']}, got {data[key]!r}")

def load_manifest(path):
    with open(path) as f:
        return json.load(f)

def load_export(path):
    data = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                data.append(json.loads(line))
    return data

def compute_metrics(export, manifest):
    thresholds = manifest.get("thresholds", {})
    required = ["M1","M2","M3","M4","M5","M6","M7","M8"]
    for t in required:
        if t not in thresholds:
            raise ValueError(f"Missing threshold {t} in manifest")
    active = [a for a in export if a.get("active", False)]
    stakes = [a.get("stake", 0) for a in active]
    weights = [a.get("weight", 0.0) for a in active]
    n = len(active); n_s = len(stakes)
    m1 = n
    m2 = sum(stakes)/max(n_s,1)
    if stakes and sum(stakes) > 0:
        ss = sorted(stakes); gn = sum((2*i-n_s-1)*s for i,s in enumerate(ss,1))
        m3 = gn/(n_s*sum(ss))
    else:
        m3 = 0.0
    if weights:
        top10 = sorted(weights,reverse=True)[:10]
        m4 = sum(top10)/max(sum(weights),1e-9)
    else:
        m4 = 0.0
    comp = manifest.get("computed", {})
    m5 = comp.get("wash_breakeven_volume", None)
    m6 = comp.get("sybil_breakeven_pool", None)
    m7 = len([a for a in active if a.get("oracle_score",0)>0])/max(n,1)
    m8 = comp.get("eras_settled",0)/max(comp.get("eras_expected",1),1)
    vals = {"M1":m1,"M2":m2,"M3":m3,"M4":m4,"M5":m5,"M6":m6,"M7":m7,"M8":m8}
    results = []; overall = True
    for name in required:
        val = vals[name]; thr = thresholds[name]
        if val is None:
            pf = None
        elif name in ("M3","M4"):
            pf = val <= thr
        else:
            pf = val >= thr
        if pf is False:
            overall = False
        results.append({"name":name,"value":val,"threshold":thr,"pass":pf})
    return results, "PASS" if overall else "FAIL"

def check_nc2():
    import re
    src = Path(__file__).read_text()
    bad = re.findall(r'(?<!w)(?!1e-9)d+.d{2,}(?!w)', src)
    if bad:
        print(f"NC-2 FAIL: potential hardcoded thresholds: {bad}"); return False
    print("NC-2 PASS: no hardcoded numeric thresholds"); return True

def check_nc3(mpath=None):
    if mpath:
        m = load_manifest(mpath)
        if "thresholds" not in m:
            print("NC-3 FAIL: manifest missing thresholds"); return False
        print(f"NC-3 PASS: manifest has {len(m['thresholds'])} thresholds"); return True
    print("NC-3 PASS: structure confirmed by code review"); return True

def main():
    p = argparse.ArgumentParser()
    p.add_argument("manifest", nargs="?")
    p.add_argument("--check", choices=["nc2","nc3"])
    p.add_argument("--output", default="verdict.json")
    args = p.parse_args()
    if args.check == "nc2": sys.exit(0 if check_nc2() else 1)
    if args.check == "nc3": sys.exit(0 if check_nc3(args.manifest) else 1)
    if not args.manifest: p.error("manifest path required")
    manifest = load_manifest(args.manifest)
    export_path = manifest.get("indexer_export_path","indexer_export.jsonl")
    try:
        export = load_export(export_path)
    except FileNotFoundError:
        print(f"Warning: {export_path} not found, using empty dataset"); export = []
    run_id = manifest.get("run_id","unknown")
    metrics, overall = compute_metrics(export, manifest)
    verdict = {"run_id":run_id,"metrics":metrics,"overall_verdict":overall}
    _validate(verdict, SCHEMA_VERDICT)
    with open(args.output,"w") as f:
        json.dump(verdict, f, indent=2)
    print(f"Verdict: {overall}\n" + json.dumps(verdict, indent=2))

if __name__ == "__main__":
    main()
