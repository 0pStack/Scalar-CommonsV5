import { describe, it, expect } from 'vitest';

import { escapeHtml, formatBalance, formatTimestamp, shortHash } from '../src/format.js';

describe('formatBalance', () => {
  it('renders whole tokens with the chain symbol', () => {
    expect(formatBalance(1_000_000_000_000n, 12, 'CMN')).toBe('1 CMN');
  });

  it('keeps the fractional part but trims trailing zeros', () => {
    expect(formatBalance(1_500_000_000_000n, 12, 'CMN')).toBe('1.5 CMN');
    expect(formatBalance(1n, 12, 'CMN')).toBe('0.000000000001 CMN');
  });

  it('groups the integer part so genesis-scale balances stay readable', () => {
    expect(formatBalance(1_000_050_000_000_000_000_000n, 12, 'CMN')).toBe('1,000,050,000 CMN');
  });

  it('renders zero without a fractional part', () => {
    expect(formatBalance(0n, 12, 'CMN')).toBe('0 CMN');
  });

  it('honours the decimals the chain actually reports', () => {
    expect(formatBalance(12_345n, 3, 'FOO')).toBe('12.345 FOO');
  });
});

describe('shortHash', () => {
  it('elides the middle of a 32-byte hash', () => {
    const hash = `0x${'ab'.repeat(32)}`;
    expect(shortHash(hash)).toBe('0xabababab…abababab');
  });

  it('leaves short values alone', () => {
    expect(shortHash('0xdeadbeef')).toBe('0xdeadbeef');
  });
});

describe('escapeHtml', () => {
  it('neutralises markup so chain data can never inject into a page', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml("it's & so")).toBe('it&#39;s &amp; so');
  });
});

describe('formatTimestamp', () => {
  it('renders the millisecond timestamp the timestamp pallet stores as ISO-8601', () => {
    expect(formatTimestamp(1_787_086_860_000n)).toBe('2026-08-18T21:01:00.000Z');
  });

  it('reports nothing when a block carries no timestamp', () => {
    expect(formatTimestamp(null)).toBe('unknown');
  });

  it('says a timestamp is out of range rather than throwing on it', () => {
    // Date only spans ±8.64e15 ms; toISOString() throws RangeError past that.
    // A timestamp that far out is not reachable on a sane runtime, but an
    // uncaught RangeError here would 502 the whole page rather than mark one
    // field as unreadable.
    expect(formatTimestamp(8_640_000_000_000_000n)).toBe('+275760-09-13T00:00:00.000Z');
    expect(formatTimestamp(8_640_000_000_000_001n)).toBe('out of range (8640000000000001 ms)');
    expect(formatTimestamp(-8_640_000_000_000_001n)).toBe('out of range (-8640000000000001 ms)');
  });
});
