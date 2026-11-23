// Vite on 1421; FRUITY_BROWSER_CHANNEL=chrome uses installed Chrome.
import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({ channel: process.env.FRUITY_BROWSER_CHANNEL || undefined });
const origin = process.env.FRUITY_APP_ORIGIN ?? 'http://127.0.0.1:1421';
try {
  // CSS must load independently of the module graph, even on a slow cold start.
  const page = await browser.newPage();
  let releaseModule;
  const moduleGate = new Promise(resolve => { releaseModule = resolve; });
  await page.route('**/src/main.ts*', async route => { await moduleGate; await route.continue(); });
  await page.goto(origin, { waitUntil: 'commit' });
  await expect(page.locator('#choose-file')).toBeVisible();
  await expect.poll(() => page.locator('#choose-file').evaluate(el => getComputedStyle(el).backgroundImage)).not.toBe('none');
  await page.screenshot({ path: 'test-results/startup-styled-before-javascript.png' });
  releaseModule();
  await page.close();

  // Exercise the real startup entrypoint with only native transport replaced.
  const native = await browser.newPage();
  const errors = [];
  native.on('pageerror', error => errors.push(error.message));
  await native.addInitScript(() => {
    window.reveals = [];
    window.readyToInit = new Promise(resolve => { window.releaseInit = resolve; });
    // A hidden WebView needn't deliver animation frames to become ready.
    window.requestAnimationFrame = () => 0;
  });
  await native.route('**/src/platform/desktop.ts*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `export const desktop = {
      available: true,
      async init() { await window.readyToInit; return {platform:'windows', version:'1.0.0', dispose(){}}; },
      async chooseFile(){return null}, async clearSelection(){}, async details(){return {pathDisplay:''}},
      async startHash(){return ''}, async cancelHash(){return 'requested'}, async compare(){return {algorithm:null,verdict:'invalid'}},
      async copyResults(){}, async close(){}, async exit(){}, async minimize(){}, async startDragging(){}
    };
    export async function showAppWindow(){ window.reveals.push({
      background:getComputedStyle(document.querySelector('#choose-file')).backgroundImage,
      platform:document.documentElement.dataset.platform,
      titlebarHidden:document.querySelector('#window-titlebar').hidden,
      version:document.querySelector('#app-version').textContent,
      imagesReady:[...document.images].every(image=>image.complete)
    }); }`,
  }));
  await native.goto(origin);
  expect(await native.evaluate(() => window.reveals)).toEqual([]);
  await native.evaluate(() => window.releaseInit());
  await expect.poll(() => native.evaluate(() => window.reveals.length)).toBe(1);
  const [reveal] = await native.evaluate(() => window.reveals);
  expect(reveal.background).not.toBe('none');
  expect(reveal).toMatchObject({platform:'windows', titlebarHidden:false, version:'v1.0', imagesReady:true});
  expect(errors).toEqual([]);
  await native.close();
  console.log('Passed: styled HTML before JavaScript, native reveal after initialization/assets, and startup without animation frames.');
} finally { await browser.close(); }
