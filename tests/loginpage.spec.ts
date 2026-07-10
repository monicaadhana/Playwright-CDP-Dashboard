import { test, expect, type Page } from './fixtures';

/**
 * Login page tests for the DIRO Client Portal (https://client.diro.io/).
 *
 * Locators/behaviour were captured from the live page:
 *   - email  → <input id="email"    placeholder="Enter your email">   (required)
 *   - pass   → <input id="password" placeholder="Enter your password"> (required)
 *   - submit → <button type="submit">Sign In</button>
 *   - empty/partial submit is blocked by native HTML5 validation (no DOM text)
 *   - wrong credentials show the toast "Invalid username or password"
 */
test.describe('Login Page Scenarios', () => {
  const LOGIN_URL = 'https://client.diro.io/';
  const INVALID_EMAIL = 'wrong@example.com';
  const INVALID_PASSWORD = 'wrongpassword';
  const VALID_EMAIL = process.env.DIRO_VALID_EMAIL;
  const VALID_PASSWORD = process.env.DIRO_VALID_PASSWORD;

  const emailField = (page: Page) => page.getByPlaceholder('Enter your email');
  const passwordField = (page: Page) => page.getByPlaceholder('Enter your password');
  const signInButton = (page: Page) => page.getByRole('button', { name: 'Sign In' });

  /** True when a field fails HTML5 constraint validation (e.g. required-but-empty). */
  const isInvalid = (page: Page, selector: string) =>
    page.locator(selector).evaluate((el) => !(el as HTMLInputElement).checkValidity());

  test.beforeEach(async ({ page }) => {
    // The persistent CDP profile may still hold a session from a previous
    // successful-login run, which redirects to /authentication/two-factor and
    // hides the login form. Clear cookies + storage so we always start logged out.
    await page.context().clearCookies();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {}
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(signInButton(page)).toBeVisible();
    await expect(emailField(page)).toBeVisible();
  });

  test('shows an error toast with incorrect credentials', async ({ page }) => {
    await emailField(page).fill(INVALID_EMAIL);
    await passwordField(page).fill(INVALID_PASSWORD);
    await signInButton(page).click();

    await expect(page.getByText('Invalid username or password')).toBeVisible({ timeout: 15000 });
    // The app keeps you on the login page after a failed attempt.
    await expect(page).toHaveURL(LOGIN_URL);
  });

  test('blocks submit when both fields are empty (HTML5 required)', async ({ page }) => {
    await signInButton(page).click();

    // Native validation blocks navigation; the email field is reported invalid.
    expect(await isInvalid(page, '#email')).toBe(true);
    await expect(page).toHaveURL(LOGIN_URL);
    await expect(emailField(page)).toHaveValue('');
    await expect(passwordField(page)).toHaveValue('');
  });

  test('blocks submit when email is missing', async ({ page }) => {
    await passwordField(page).fill(INVALID_PASSWORD);
    await signInButton(page).click();

    expect(await isInvalid(page, '#email')).toBe(true);
    await expect(page).toHaveURL(LOGIN_URL);
    await expect(passwordField(page)).toHaveValue(INVALID_PASSWORD);
  });

  test('blocks submit when password is missing', async ({ page }) => {
    await emailField(page).fill(INVALID_EMAIL);
    await signInButton(page).click();

    expect(await isInvalid(page, '#password')).toBe(true);
    await expect(page).toHaveURL(LOGIN_URL);
    await expect(emailField(page)).toHaveValue(INVALID_EMAIL);
  });

  test('logs in successfully with valid credentials', async ({ page }) => {
    test.skip(
      !VALID_EMAIL || !VALID_PASSWORD,
      'Set DIRO_VALID_EMAIL and DIRO_VALID_PASSWORD to run the real-login test.',
    );

    await emailField(page).fill(VALID_EMAIL!);
    await passwordField(page).fill(VALID_PASSWORD!);
    await signInButton(page).click();

    // Success = we leave the login page. (Note: the page uses reCAPTCHA, so an
    // automated login may still be challenged depending on the site's config.)
    await expect(page).not.toHaveURL(LOGIN_URL, { timeout: 20000 });
    await expect(signInButton(page)).toBeHidden();
  });
});
