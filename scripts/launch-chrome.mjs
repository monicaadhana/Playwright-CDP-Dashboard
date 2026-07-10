// Launch the installed Chrome with a remote debugging port so Playwright
// tests and the Playwright MCP can attach to it over CDP.
import { spawn } from 'node:child_process';
import {
  CDP_ENDPOINT,
  CDP_PORT,
  chromeArgs,
  cdpStatus,
  findChrome,
} from './chrome-utils.mjs';

const existing = await cdpStatus();
if (existing) {
  console.log(`✓ A CDP browser is already listening at ${CDP_ENDPOINT}`);
  console.log(`  ${existing.Browser} — webSocketDebuggerUrl ready`);
  process.exit(0);
}

const chrome = findChrome();
if (!chrome) {
  console.error(
    'Could not find Chrome or Edge. Set CHROME_PATH to your browser executable.',
  );
  process.exit(1);
}

console.log(`Launching: ${chrome}`);
console.log(`  --remote-debugging-port=${CDP_PORT}`);

const child = spawn(chrome, chromeArgs(), {
  detached: true,
  stdio: 'ignore',
});
child.unref();

// Wait until the CDP endpoint answers, then report success.
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const status = await cdpStatus();
  if (status) {
    console.log(`✓ Chrome is up. CDP endpoint: ${CDP_ENDPOINT}`);
    console.log(`  ${status.Browser}`);
    process.exit(0);
  }
}

console.error(`Chrome launched but ${CDP_ENDPOINT} never responded.`);
process.exit(1);
