import { test, expect, type Page } from './fixtures';
import { createWorker } from 'tesseract.js';

/**
 * DIRO CP_Positive Flow (DIRO-TC-1943 "Verify Capture process") — DETERMINISTIC.
 *
 * The manual/AI executor can't reliably drive this flow (custom select2 pickers, a
 * <canvas>-rendered bank/document screen, and intermittent bot-detection), so this is a
 * hand-written regression with REAL assertions at every checkpoint. Locators were verified
 * live over CDP; the one canvas step (choosing "Utility bill-1") is clicked by OCR.
 *
 * The verification/capture link is dynamic/session-specific, so it is NOT hardcoded —
 * set a fresh one in .env as DIRO_VERIFICATION_URL before running, e.g.
 *   DIRO_VERIFICATION_URL=https://verification.diro.io/?buttonid=...&trackid=...
 * The test skips itself when that isn't set.
 *
 * Flow: privacy → Continue → country (Trinidad and Tobago) → bank (Testing99) →
 *       Start → testing99 site → Utility bill-1 (canvas) → download → Submit → success.
 */

const VERIFY_URL = process.env.DIRO_VERIFICATION_URL;

// ---- OCR helper: the testing99 document list is painted on a <canvas> (no DOM), so we
// locate "Utility bill-1" by OCR and click its pixel. Fuzzy match tolerates tesseract
// misreads (e.g. "Utility" -> "Utiity") and ignores the right-column item on the line.
const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function fuzzySubstr(text: string, pat: string): number {
  const n = text.length, m = pat.length;
  let prev = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1); cur[0] = i;
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (pat[i - 1] === text[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.min(...prev);
}
let ocrWorker: Awaited<ReturnType<typeof createWorker>> | null = null;
// OCR the viewport, fuzzy-match `target`, return its CSS-pixel click point (or null).
async function ocrFind(page: Page, target: string): Promise<{ x: number; y: number } | null> {
  const buf = await page.screenshot(); // device-scale — readable resolution for OCR
  const imgW = buf.readUInt32BE(16), imgH = buf.readUInt32BE(20);
  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const sx = vp.w / imgW, sy = vp.h / imgH;
  ocrWorker = ocrWorker ?? (await createWorker('eng'));
  const { data } = await ocrWorker.recognize(buf, {}, { blocks: true } as any);
  const want = norm(target);
  let best: any = null, bestD = Infinity;
  for (const bl of (data as any).blocks || []) for (const par of bl.paragraphs || []) for (const ln of par.lines || []) {
    const d = fuzzySubstr(norm(ln.text), want);
    if (d < bestD) { bestD = d; best = ln.bbox; }
  }
  if (!best || bestD > Math.max(2, Math.round(want.length * 0.25))) return null;
  return { x: Math.round((best.x0 + 25) * sx), y: Math.round((best.y0 + best.y1) / 2 * sy) };
}

test.describe('DIRO CP_Positive Flow — deterministic', () => {
  test.skip(!VERIFY_URL, 'Set DIRO_VERIFICATION_URL in .env (a fresh verification link) to run this flow.');

  test('capture process completes: privacy → bank → download → submit → success', async ({ page }) => {
    test.setTimeout(240_000);
    page.on('dialog', (d) => d.accept().catch(() => {})); // DIRO raises beforeunload/confirm dialogs

    // 1–2. Open the verification URL; the "Your privacy" pop-up appears.
    await page.goto(VERIFY_URL!, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const continueBtn = page.getByRole('button', { name: 'Continue' });
    await expect(continueBtn, 'privacy pop-up Continue button').toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Your privacy')).toBeVisible();

    // 3–4. Continue is a no-op until its handler wires up — click until the flow advances.
    await expect(async () => {
      await continueBtn.click({ timeout: 8_000, noWaitAfter: true }).catch(() => {});
      await expect(page.getByText(/Select Your Bank/i)).toBeVisible({ timeout: 4_000 });
    }).toPass({ timeout: 45_000 });

    // 5–7. Country picker is a select2: open → type → choose "Trinidad and Tobago".
    await page.locator('.select2-selection').first().click();
    await page.locator('.select2-search__field').fill('Trinidad');
    await page.locator('.select2-results__option', { hasText: 'Trinidad' }).first().click();
    await expect(page.locator('.select2-selection__rendered').first()).toHaveAttribute('title', /Trinidad and Tobago/);

    // 8–11. Bank search → select the Testing99 "Test Bank" (testing99.diro.me).
    await page.locator('#floatingInput').fill('Testing99');
    await page.getByText('testing99.diro.me').first().click({ timeout: 10_000 });

    // 12–16. "Bank verification" pop-up → Start → the testing99 document page loads.
    const startBtn = page.getByRole('button', { name: /^start$/i });
    await expect(startBtn, 'Bank verification Start button').toBeVisible({ timeout: 30_000 });
    await startBtn.click({ noWaitAfter: true });

    // 17–19. The testing99 page (banner + document list) is rendered on a <canvas> — no DOM,
    // so we can't assert its text via getByText. Instead retry the OCR locate until the
    // canvas has painted "Utility bill-1", then click that pixel; the download begins.
    let billPoint: { x: number; y: number } | null = null;
    for (let i = 0; i < 15 && !billPoint; i++) {
      billPoint = await ocrFind(page, 'Utility bill-1');
      if (!billPoint) await page.waitForTimeout(4_000);
    }
    expect(billPoint, '"Utility bill-1" located on the canvas').not.toBeNull();
    await page.mouse.click(billPoint!.x, billPoint!.y);

    // 20–25. Download progresses to completion, then a review/submit dialog appears.
    await expect(async () => {
      const t = (await page.evaluate(() => (document.body ? document.body.innerText : ''))) || '';
      expect(/please review|proceed anyway|download complete|submit/i.test(t)).toBeTruthy();
    }).toPass({ timeout: 120_000 });
    for (const name of [/proceed anyway/i, /^submit$/i]) {
      const b = page.getByRole('button', { name });
      if ((await b.count()) && (await b.first().isVisible().catch(() => false))) {
        await b.first().click({ noWaitAfter: true });
        break;
      }
    }

    // 26–28. Verifying → final success ("Submission successful" / Thank You).
    await expect(page.getByText(/submission successful|thank you/i).first(), 'final success screen').toBeVisible({ timeout: 120_000 });
  });
});
