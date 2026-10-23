import { afterAll, afterEach } from 'vitest';
import { E2E_ALLOW_SKIP } from './chain.js';

let executed = 0;
afterEach(() => {
  executed += 1;
});
afterAll(() => {
  if (!E2E_ALLOW_SKIP && executed === 0) {
    throw new Error(
      'live test file executed zero tests; set E2E_ALLOW_SKIP=1 only when that skip is intentional',
    );
  }
});
