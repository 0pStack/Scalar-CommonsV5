/** CLI parsing, kept pure so the gate's shape is testable without a chain. */

export const DEFAULTS = {
  endpoint: 'ws://127.0.0.1:9944',
  eras: 1,
  rounds: 2,
  archetype: 'all',
  waitMinutes: 45,
  json: null,
};

export function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--endpoint': out.endpoint = next(); break;
      case '--eras': out.eras = Number(next()); break;
      case '--rounds': out.rounds = Number(next()); break;
      case '--archetype': out.archetype = next(); break;
      case '--wait-minutes': out.waitMinutes = Number(next()); break;
      case '--json': out.json = next(); break;
      case '-h': case '--help': out.help = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`unrecognised flag: ${a}`);
    }
  }
  if (!Number.isInteger(out.eras) || out.eras < 0) throw new Error('--eras must be a non-negative integer');
  if (!Number.isInteger(out.rounds) || out.rounds < 1) throw new Error('--rounds must be >= 1');
  if (!Number.isFinite(out.waitMinutes) || out.waitMinutes < 0) throw new Error('--wait-minutes must be >= 0');
  return out;
}

export const USAGE = `
experiments/live — run the ENDGOAL §3.4 attacker archetypes against a live chain

  node run.mjs [--archetype <name|all>] [--eras N] [--rounds N]
               [--endpoint ws://...] [--wait-minutes N] [--json out.json]

  --archetype   honest | wash | sybil | oracle | governance | passive | all
  --eras        settlements to wait for before measuring (default 1; 0 = do not wait)
  --rounds      strategy repetitions inside the era (default 2)
  --wait-minutes  give up waiting for settlement after this long and report
                  what was realised (default 45)

Every archetype submits REAL extrinsics with fresh accounts funded from //Alice.
There are no fixtures. Costs are always real; rewards require a settled era.
`;
