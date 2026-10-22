import { describe, expect, it } from 'vitest';

import * as sdk from '../src/index.js';

describe('public SDK exports', () => {
  it('keeps messaging implementation helpers private', () => {
    expect(sdk).not.toHaveProperty('hsalsa20');
    expect(sdk).not.toHaveProperty('boxBeforenm');
    expect(sdk).not.toHaveProperty('toAccountId');
  });
});
