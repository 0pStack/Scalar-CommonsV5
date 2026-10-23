import type { Reporter, TestModule } from 'vitest/node';

const allowSkip = /^(1|true|yes)$/i.test(process.env.E2E_ALLOW_SKIP ?? '');

export class MinimumExecutedReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    if (allowSkip) return;

    const emptyModules = testModules.filter((module) => {
      const tests = [...module.children.allTests()];
      return !tests.some((test) => {
        const state = test.result().state;
        return state === 'passed' || state === 'failed';
      });
    });

    if (emptyModules.length === 0) return;

    const files = emptyModules.map(({ relativeModuleId }) => relativeModuleId).join(', ');
    console.error(
      `\n[e2e] Live test modules executed zero tests: ${files}. ` +
        'Set E2E_ALLOW_SKIP=1 only when that skip is intentional.\n',
    );
    process.exitCode = 1;
  }
}
