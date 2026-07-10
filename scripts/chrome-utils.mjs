// Shared helpers for launching / inspecting the CDP Chrome instance.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const CDP_PORT = Number(process.env.CDP_PORT ?? 9222);
export const CDP_ENDPOINT =
  process.env.CDP_ENDPOINT ?? `http://localhost:${CDP_PORT}`;

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

// Dedicated profile so we never disturb the user's normal Chrome session
// and so the --remote-debugging-port flag is actually honored.
export const USER_DATA_DIR = path.join(projectRoot, '.chrome-cdp-profile');

/** Locate an installed Chrome (falls back to Edge) across common Windows paths. */
export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(
      process.env.LOCALAPPDATA ?? '',
      'Google\\Chrome\\Application\\chrome.exe',
    ),
    // Fall back to Edge (Chromium-based, speaks CDP too).
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export function chromeArgs() {
  return [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    'about:blank',
  ];
}

/** Returns the CDP /json/version payload if a debug browser is listening. */
export async function cdpStatus() {
  try {
    const res = await fetch(`${CDP_ENDPOINT}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
