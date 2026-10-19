/**
 * The report's presentation layer, offline against known rows.
 *
 * This is where a real finding turns into a headline, so the verdict wording is
 * pinned: "profitable" and "PROFITABLE AND BEATS HONEST WORK" are different
 * claims and must not be interchangeable.
 */
import { describe, expect, it } from 'vitest';
import { renderTable, renderVerdict, renderFailures } from '../src/table.mjs';
import { cmnToPlancks } from '../src/units.mjs';

const CMN = cmnToPlancks;
const row = (key, title, net, extra = {}) => ({
  key, title, netPlancks: net, fundedPlancks: CMN(3000), extrinsics: 5,
  accounts: ['a'], failures: [], notes: [], status: 'SETTLED', ...extra,
});

describe('renderTable', () => {
  it('shows every archetype and a signed net', () => {
    const out = renderTable([row('honest', 'Honest worker', CMN(100)), row('wash', 'Wash trader', CMN(-20))]);
    expect(out).toContain('Honest worker');
    expect(out).toContain('Wash trader');
    expect(out).toContain('+100.0000');
    expect(out).toContain('-20.0000');
  });
  it('gives the baseline a dash rather than a self-comparison', () => {
    const out = renderTable([row('honest', 'Honest worker', CMN(100))]);
    expect(out).toMatch(/Honest worker.*—/);
  });
  it('computes vs-honest as a signed difference', () => {
    const out = renderTable([row('honest', 'Honest worker', CMN(100)), row('wash', 'Wash trader', CMN(140))]);
    expect(out).toContain('+40.0000');
  });
});

describe('renderVerdict', () => {
  it('calls a positive net profitable, and not merely "…profitable" inside "unprofitable"', () => {
    const v = renderVerdict([row('honest', 'Honest worker', CMN(100)), row('wash', 'Wash trader', CMN(10))]);
    // "unprofitable" CONTAINS "profitable", so a naive substring or a
    // /.*profitable/ regex matches both verdicts and asserts nothing. Anchor on
    // the word boundary instead. This mattered: the first version of this test
    // was written the naive way and passed against either outcome.
    expect(v).toMatch(/Wash trader\s+\S+ CMN\s+profitable$/m);
    expect(v).not.toMatch(/unprofitable/);
  });
  it('escalates when an attacker also beats honest work', () => {
    const v = renderVerdict([row('honest', 'Honest worker', CMN(10)), row('wash', 'Wash trader', CMN(100))]);
    expect(v).toContain('PROFITABLE AND BEATS HONEST WORK');
  });
  it('does not escalate a profitable attacker that still trails honest work', () => {
    const v = renderVerdict([row('honest', 'Honest worker', CMN(100)), row('wash', 'Wash trader', CMN(10))]);
    expect(v).not.toContain('BEATS HONEST WORK');
  });
  it('calls a negative net unprofitable', () => {
    const v = renderVerdict([row('honest', 'Honest worker', CMN(100)), row('wash', 'Wash trader', CMN(-5))]);
    expect(v).toContain('unprofitable');
  });
  it('treats exactly break-even as not profitable', () => {
    const v = renderVerdict([row('honest', 'Honest worker', CMN(100)), row('wash', 'Wash trader', 0n)]);
    expect(v).toContain('unprofitable');
  });
  it('omits the baseline from the verdict list', () => {
    const v = renderVerdict([row('honest', 'Honest worker', CMN(100))]);
    expect(v).toBe('');
  });
});

describe('renderFailures', () => {
  it('says so plainly when nothing was refused', () => {
    expect(renderFailures([row('wash', 'Wash trader', 0n)])).toContain('every extrinsic was accepted');
  });
  it('groups repeated refusals with a count', () => {
    const r = row('wash', 'Wash trader', 0n, {
      failures: [
        { step: 'confirmDelivery', message: 'escrow.NotAgent' },
        { step: 'confirmDelivery', message: 'escrow.NotAgent' },
      ],
    });
    const out = renderFailures([r]);
    expect(out).toContain('2x confirmDelivery: escrow.NotAgent');
  });
});
