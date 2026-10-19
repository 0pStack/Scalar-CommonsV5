/** CLI parsing — the gate's exact invocation must keep working. */
import { describe, expect, it } from 'vitest';
import { parseArgs, DEFAULTS } from '../src/args.mjs';

describe('parseArgs', () => {
  it('parses the gate invocation', () => {
    const o = parseArgs(['--archetype', 'wash', '--eras', '1']);
    expect(o.archetype).toBe('wash');
    expect(o.eras).toBe(1);
  });
  it('defaults to the local node and all archetypes', () => {
    const o = parseArgs([]);
    expect(o.endpoint).toBe(DEFAULTS.endpoint);
    expect(o.archetype).toBe('all');
  });
  it('accepts --eras 0, which means do not wait for settlement', () => {
    expect(parseArgs(['--eras', '0']).eras).toBe(0);
  });
  it('rejects a negative or fractional era count instead of silently flooring it', () => {
    expect(() => parseArgs(['--eras', '-1'])).toThrow();
    expect(() => parseArgs(['--eras', '1.5'])).toThrow();
  });
  it('rejects --rounds 0, which would run a strategy that does nothing', () => {
    expect(() => parseArgs(['--rounds', '0'])).toThrow();
  });
  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unrecognised/);
  });
  it('rejects a flag with no value', () => {
    expect(() => parseArgs(['--eras'])).toThrow(/needs a value/);
  });
});
