// Stop the CDP Chrome instance by asking it to close via the CDP endpoint,
// falling back to killing the process bound to the debug port on Windows.
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { CDP_ENDPOINT, CDP_PORT, cdpStatus } from './chrome-utils.mjs';

const execAsync = promisify(exec);

const status = await cdpStatus();
if (!status) {
  console.log(`No CDP browser is listening at ${CDP_ENDPOINT}. Nothing to do.`);
  process.exit(0);
}

// Ask Chrome to close cleanly.
try {
  await fetch(`${CDP_ENDPOINT}/json/close`, {
    signal: AbortSignal.timeout(1500),
  });
} catch {
  /* ignore — fall through to killing by port */
}

await new Promise((r) => setTimeout(r, 800));

if (await cdpStatus()) {
  // Still up: kill whatever owns the debug port (Windows).
  try {
    const { stdout } = await execAsync(
      `netstat -ano | findstr :${CDP_PORT} | findstr LISTENING`,
    );
    const pids = new Set(
      stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/).pop())
        .filter((pid) => pid && /^\d+$/.test(pid)),
    );
    for (const pid of pids) {
      await execAsync(`taskkill /PID ${pid} /T /F`);
      console.log(`Killed PID ${pid}`);
    }
  } catch (err) {
    console.error('Could not stop Chrome automatically:', err.message);
    process.exit(1);
  }
}

console.log('✓ CDP Chrome stopped.');
