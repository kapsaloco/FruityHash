// Run with Vite serving on 1421: node tests/visual/verify-fruity.mjs
// Override with FRUITY_PREVIEW_URL if using another port.
import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({ headless: true, channel: process.env.FRUITY_BROWSER_CHANNEL || undefined });
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(process.env.FRUITY_PREVIEW_URL ?? 'http://127.0.0.1:1421/tests/visual/fruity.html');
  const overview = page.getByRole('tab', { name: 'Overview' });
  const activity = page.getByRole('tab', { name: 'Activity' });
  await overview.focus();
  await page.keyboard.press('ArrowRight');
  await expect(activity).toBeFocused();
  await expect(activity).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#overview-panel')).toBeHidden();
  await page.keyboard.press('ArrowRight');
  await expect(overview).toBeFocused(); // skip disabled History and wrap
  await page.keyboard.press('End');
  await expect(activity).toBeFocused();
  await page.keyboard.press('Home');
  await expect(overview).toBeFocused();
  const radio = page.getByRole('radio', { name: 'Comfortable' });
  await radio.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Compact', exact: true })).toBeChecked();
  for (const name of ['Settings', 'Open dialog']) {
    const opener = page.getByRole('button', { name, exact: true });
    await opener.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Save settings', exact: true }).focus();
    await page.keyboard.press('Tab');
    // Chromium may pass through browser chrome at the document boundary.
    expect(await page.evaluate(() => document.activeElement === document.body || document.querySelector('dialog').contains(document.activeElement))).toBe(true);
    if (await page.evaluate(() => document.activeElement === document.body)) await page.keyboard.press('Tab');
    await expect(page.getByRole('checkbox', { name: 'Show helpful status messages' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(opener).toBeFocused();
  }
  const tipTrigger = page.getByRole('button', { name: 'About local storage' });
  await tipTrigger.focus();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toBeHidden();
  await page.getByRole('button', { name: 'Show notification' }).click();
  await expect(page.locator('.fr-toast')).toHaveCount(1);
  await expect(page.locator('.fr-toast__message')).toContainText('Copied to clipboard');
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.locator('.fr-toast')).toHaveCount(0);
  await expect(page.locator('#preview-toasts')).toBeFocused();
  const details = page.locator('.fr-disclosure').first();
  await details.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(details).toHaveAttribute('open', '');
  for (const width of [900, 520, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('#opening .fr-meter__fill').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await page.emulateMedia({ forcedColors: 'active' });
  await overview.focus();
  expect(await overview.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 900, height: 900 });
  await page.screenshot({ path: 'test-results/fruity-components.png', fullPage: true });
  expect(errors).toEqual([]);
  console.log('Passed: tabs, native radios, dialog trap/return, tooltip Escape, toast dismissal, disclosures, 3 widths, reduced motion, focus, and runtime errors.');
} finally { await browser.close(); }
