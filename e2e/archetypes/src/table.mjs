/**
 * The report table.
 *
 * Kept separate from anything that touches the chain so it can be tested
 * offline against known rows — the formatting is where a sign error or a
 * silently-dropped row would turn a real finding into a wrong headline.
 */

import { signedCmn, plancksToCmn } from './units.mjs';

export function renderTable(rows, { baselineKey = 'honest' } = {}) {
  const baseline = rows.find((r) => r.key === baselineKey);
  const header = ['archetype', 'accounts', 'extrinsics', 'funded CMN', 'net CMN', 'vs honest', 'status'];
  const body = rows.map((r) => {
    const vs = baseline && r.key !== baselineKey
      ? signedCmn(r.netPlancks - baseline.netPlancks)
      : (r.key === baselineKey ? '—' : 'n/a');
    return [
      r.title,
      String(r.accounts?.length ?? 0),
      String(r.extrinsics),
      plancksToCmn(r.fundedPlancks, 2),
      signedCmn(r.netPlancks),
      vs,
      r.status,
    ];
  });
  const all = [header, ...body];
  const w = header.map((_, i) => Math.max(...all.map((row) => row[i].length)));
  const line = (row) => row.map((c, i) => (i <= 1 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  const sep = w.map((n) => '-'.repeat(n)).join('  ');
  return [line(header), sep, ...body.map(line)].join('\n');
}

/**
 * The verdict line.
 *
 * ENDGOAL §3.4 says "if wash trading still pays, the project does not launch",
 * so the only thing that matters is the SIGN of an attacker's net relative to
 * zero, and its position relative to honest work. Both are stated; neither is
 * softened.
 */
export function renderVerdict(rows, { baselineKey = 'honest' } = {}) {
  const baseline = rows.find((r) => r.key === baselineKey);
  const out = [];
  for (const r of rows) {
    if (r.key === baselineKey) continue;
    const profitable = r.netPlancks > 0n;
    const beatsHonest = baseline ? r.netPlancks > baseline.netPlancks : false;
    const verdict = profitable
      ? (beatsHonest ? 'PROFITABLE AND BEATS HONEST WORK' : 'profitable')
      : 'unprofitable';
    out.push(`  ${r.title.padEnd(20)} ${signedCmn(r.netPlancks).padStart(14)} CMN  ${verdict}`);
  }
  return out.join('\n');
}

export function renderFailures(rows) {
  const out = [];
  for (const r of rows) {
    if (!r.failures.length) continue;
    out.push(`  ${r.title}:`);
    // A refused extrinsic is a result, not noise: it distinguishes "the chain
    // blocked this" from "the chain let it through and it lost money".
    const seen = new Map();
    for (const f of r.failures) {
      const k = `${f.step}: ${f.message}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    for (const [k, n] of seen) out.push(`    ${n}x ${k}`);
  }
  return out.length ? out.join('\n') : '  (none — every extrinsic was accepted)';
}
