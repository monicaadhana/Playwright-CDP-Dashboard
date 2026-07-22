// Thin Google AI Studio (Gemini) client — no SDK, just fetch.
// Reads GEMINI_API_KEY / GEMINI_MODEL from the environment (loaded from .env).
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Transient server-side errors worth retrying: 429 (rate limit), 500 (internal),
// 503 (UNAVAILABLE / model overloaded — "experiencing high demand").
const RETRYABLE_STATUS = new Set([429, 500, 503]);
const MAX_RETRIES = 4; // total attempts = MAX_RETRIES + 1
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isConfigured() {
  return !!process.env.GEMINI_API_KEY;
}

/**
 * Call Gemini's generateContent.
 * @param {string} prompt        the user prompt
 * @param {object} [opts]
 * @param {string} [opts.system] system instruction
 * @param {boolean} [opts.json]  request application/json output
 * @param {object} [opts.schema] optional responseSchema (implies json)
 * @returns {Promise<string>} the model's text output
 */
export async function generate(prompt, opts = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set. Add it to .env.');

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      // Generous cap so long files (generated specs) don't get truncated.
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
    },
  };
  // Flash models (2.5-flash, 3.x-flash, gemini-flash-latest) "think" by default, and
  // thinking tokens eat the output budget — which truncates/mangles JSON mid-string.
  // Disable it for these calls (verified thinkingBudget:0 is accepted by flash-latest).
  if (/2\.5|flash/i.test(MODEL)) {
    body.generationConfig.thinkingConfig = { thinkingBudget: opts.thinkingBudget ?? 0 };
  }
  if (opts.system) {
    body.system_instruction = { parts: [{ text: opts.system }] };
  }
  if (opts.json || opts.schema) {
    body.generationConfig.responseMimeType = 'application/json';
    if (opts.schema) body.generationConfig.responseSchema = opts.schema;
  }

  // Retry transient failures (overload/rate-limit/internal + network errors) with
  // exponential backoff so a temporary Gemini spike doesn't fail the whole run.
  let res, lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      res = await fetch(`${API_BASE}/${MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
    } catch (err) {
      // Network error / timeout — retryable.
      lastErr = err;
      res = null;
    }
    if (res && res.ok) break;
    const retryable = !res || RETRYABLE_STATUS.has(res.status);
    if (!retryable || attempt === MAX_RETRIES) {
      if (res && !res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Gemini API ${res.status}: ${detail.slice(0, 400)}`);
      }
      throw new Error(`Gemini request failed after ${attempt + 1} attempt(s): ${lastErr?.message || 'unknown error'}`);
    }
    // Backoff: 1s, 2s, 4s, 8s (+ small jitter to de-sync parallel callers).
    const wait = 1000 * 2 ** attempt + Math.floor((attempt * 137) % 250);
    await sleep(wait);
  }

  const data = await res.json();
  const cand = data.candidates?.[0];
  if (!cand) {
    const reason = data.promptFeedback?.blockReason;
    throw new Error(reason ? `Gemini blocked the request: ${reason}` : 'Gemini returned no candidates.');
  }
  const text = (cand.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  if (cand.finishReason === 'MAX_TOKENS') {
    throw new Error(
      'Gemini hit the output token limit (response truncated). Try a shorter/simpler scenario or raise maxOutputTokens.',
    );
  }
  if (!text) {
    throw new Error(`Gemini returned an empty response (finishReason: ${cand.finishReason ?? 'unknown'}).`);
  }
  return text;
}

/** Like generate(), but parses the JSON result (tolerating ```json fences). */
export async function generateJSON(prompt, opts = {}) {
  const raw = await generate(prompt, { ...opts, json: true });
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`Gemini did not return valid JSON:\n${raw.slice(0, 400)}`);
  }
}

/** Quick connectivity/auth check. */
export async function health() {
  if (!isConfigured()) return { ok: false, error: 'GEMINI_API_KEY not set' };
  try {
    const text = await generate('Reply with the single word: ok', {});
    return { ok: true, model: MODEL, sample: text.slice(0, 40) };
  } catch (err) {
    return { ok: false, model: MODEL, error: err.message };
  }
}
