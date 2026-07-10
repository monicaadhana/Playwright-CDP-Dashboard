import path from 'node:path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

/**
 * Emits newline-delimited JSON events to stdout, each prefixed with a marker.
 * The dashboard server parses these to drive the live status grid, while all
 * other stdout lines are streamed to the log panel as-is.
 */
const MARKER = '@@PW@@';

function emit(event: Record<string, unknown>) {
  process.stdout.write(`\n${MARKER}${JSON.stringify(event)}\n`);
}

/** "file.spec.ts › describe › test" without the empty project segment. */
function titleOf(test: TestCase) {
  return test.titlePath().filter(Boolean).join(' › ');
}

const toRel = (p: string) => path.relative(process.cwd(), p).split(path.sep).join('/');

/** Spec file, relative to the project root (forward slashes). */
function fileOf(test: TestCase) {
  return test.location?.file ? toRel(test.location.file) : '';
}

export default class WsReporter implements Reporter {
  onBegin(_config: FullConfig, suite: Suite) {
    const tests = suite.allTests();
    emit({
      type: 'begin',
      total: tests.length,
      tests: tests.map((t) => ({ id: t.id, title: titleOf(t), file: fileOf(t) })),
    });
  }

  onTestBegin(test: TestCase) {
    emit({ type: 'testBegin', id: test.id, title: titleOf(test) });
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const screenshots = result.attachments
      .filter((a) => a.name === 'screenshot' && a.path)
      .map((a) => toRel(a.path as string));
    emit({
      type: 'testEnd',
      id: test.id,
      title: titleOf(test),
      file: fileOf(test),
      status: result.status,
      duration: result.duration,
      error: result.error?.message?.split('\n')[0],
      screenshots,
    });
  }

  onEnd(result: FullResult) {
    emit({ type: 'end', status: result.status });
  }

  printsToStdio() {
    return true;
  }
}
