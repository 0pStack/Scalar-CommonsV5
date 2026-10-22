import { describe, it, expect } from 'vitest';

import { isLoopbackHostname } from '../src/index.js';

describe('isLoopbackHostname — exact loopback names only', () => {
  it('accepts the three loopback hostnames a URL parser produces', () => {
    for (const h of ['127.0.0.1', 'localhost', '[::1]'])
      expect(isLoopbackHostname(h), h).toBe(true);
    expect(isLoopbackHostname(new URL('http://[::1]:8080/').hostname)).toBe(true);
  });

  it('rejects look-alikes and anything else', () => {
    for (const h of [
      'localhost.evil.example',
      '127.0.0.2',
      '::1',
      'LOCALHOST',
      '',
      'example.com',
      '0.0.0.0',
    ]) {
      expect(isLoopbackHostname(h), h).toBe(false);
    }
  });
});
