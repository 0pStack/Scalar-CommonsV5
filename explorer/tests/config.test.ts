import { describe, it, expect } from 'vitest';

import { readIntEnv } from '../src/config.js';

describe('readIntEnv', () => {
  it('uses the fallback when the variable is unset', () => {
    expect(readIntEnv('EXPLORER_PORT', undefined, 8080, 0, 65_535)).toBe(8080);
  });

  it('reads an integer the operator set', () => {
    expect(readIntEnv('EXPLORER_PORT', '9000', 8080, 0, 65_535)).toBe(9000);
  });

  it('refuses a non-numeric value instead of degrading to NaN', () => {
    // Number('nope') is NaN, and NaN survives Math.max, arithmetic and
    // Array.from — a bad value would otherwise reach the page as a silently
    // empty view rather than as a failure.
    expect(() => readIntEnv('EXPLORER_PORT', 'nope', 8080, 0, 65_535)).toThrow(/EXPLORER_PORT/);
  });

  it('refuses a value that is numeric but not a whole number', () => {
    expect(() => readIntEnv('EXPLORER_PORT', '80.5', 8080, 0, 65_535)).toThrow(/EXPLORER_PORT/);
    expect(() => readIntEnv('EXPLORER_PORT', '', 8080, 0, 65_535)).toThrow(/EXPLORER_PORT/);
  });

  it('refuses a value outside the range the caller can use', () => {
    expect(() => readIntEnv('EXPLORER_PORT', '-1', 8080, 0, 65_535)).toThrow(/EXPLORER_PORT/);
    expect(() => readIntEnv('EXPLORER_PORT', '70000', 8080, 0, 65_535)).toThrow(/EXPLORER_PORT/);
  });
});
