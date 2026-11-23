// Start Vite on 1421. Set FRUITY_BROWSER_CHANNEL=chrome to use installed Chrome.
import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({ headless: true, channel: process.env.FRUITY_BROWSER_CHANNEL });
const page = await browser.newPage();
const errors = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => requests.push(request.url()));
try {
  await page.goto(process.env.FRUITY_UTILITY_URL ?? 'http://127.0.0.1:1421/tests/visual/utility.html');
  await expect(page).toHaveURL(/\/fruity\.html$/);
  await expect(page.locator('.fr-panel--glass').first()).toBeVisible();
  await expect(page.locator('.preview-nav a')).toHaveCount(2);
  await expect(page.locator('[data-fruity-ui-version]')).toHaveText('v1.0');
  await expect(page.getByRole('heading', {name:'Buttons', exact:true})).toHaveCount(1);
  await expect(page.getByRole('heading', {name:'Empty state', exact:true})).toHaveCount(1);
  expect(requests.some(url => url.includes('/src/styles/fruity/index.css'))).toBe(true);
  expect(requests.some(url => /\/src\/(styles\/app.css|app.ts|platform\/)/.test(url))).toBe(false);
  const images = page.getByRole('checkbox', { name: 'Images' });
  await images.focus();
  await page.keyboard.press('Space');
  await expect(images).toBeChecked();
  const opener = page.getByRole('button', { name: 'Open dialog', exact: true });
  await opener.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  await page.getByText('Copy the verdict markup', { exact: true }).click();
  for (const width of [1000, 520, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow at ${width}px`).toBe(true);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Primary action', exact: true }).hover();
  expect(await page.locator('.fr-button--hero').first().evaluate(el => getComputedStyle(el, '::after').animationName)).toBe('none');
  expect(await page.locator('.fr-local-badge .fr-statusbar__light').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await page.emulateMedia({ forcedColors: 'active' });
  expect(await page.locator('.fr-verdict').first().evaluate(el => getComputedStyle(el).boxShadow)).toBe('none');
  await page.emulateMedia({ forcedColors: 'none' });
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.screenshot({ path: 'test-results/fruity-utility.png', fullPage: true });
  expect(errors).toEqual([]);
  console.log('Passed: old gallery redirects, two-page navigation, v1.0, single component examples, native choices, dialog focus, three widths and accessibility fallbacks.');
} finally { await browser.close(); }
