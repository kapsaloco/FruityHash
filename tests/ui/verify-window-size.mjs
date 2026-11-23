import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({ channel: process.env.FRUITY_BROWSER_CHANNEL || undefined });
const origin = process.env.FRUITY_APP_ORIGIN ?? 'http://127.0.0.1:1421';
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
  await page.route('**/src/main.ts*', route => route.fulfill({ contentType: 'application/javascript', body: 'import "/tests/ui/app-fixture.ts";' }));
  await page.route('**/*@tauri-apps_api_core*', route => route.fulfill({ contentType: 'application/javascript', body: 'export class Channel {} export const invoke = async () => {}; export const isTauri = () => true;' }));
  await page.route('**/*@tauri-apps_api_window*', route => route.fulfill({ contentType: 'application/javascript', body: `
    export class LogicalSize { constructor(width,height) { this.width=width; this.height=height; } }
    export const currentMonitor = async () => ({workArea:{size:{height:window.sizing.workHeight}}});
    export const getCurrentWindow = () => ({
      async innerSize(){return {width:800*window.sizing.scale,height:800*window.sizing.scale}},
      async outerSize(){return {width:800*window.sizing.scale,height:800*window.sizing.scale+window.sizing.frame}},
      async scaleFactor(){return window.sizing.scale},
      async setSize(size){window.sizing.result=size;window.sizing.calls.push('size')},
      async center(){window.sizing.calls.push('center')},
      async show(){window.sizing.calls.push('show')}
    });` }));
  await page.goto(origin);
  await expect(page.locator('#window-titlebar')).toBeVisible();
  for (const scenario of [
    {scale:1, workHeight:1040, frame:0},
    {scale:1.5, workHeight:1560, frame:0},
    {scale:1.5, workHeight:1560, frame:48},
    {scale:1.5, workHeight:1080, frame:0},
  ]) {
    await page.setViewportSize({width:800,height:800});
    const result = await page.evaluate(async scenario => {
      window.sizing={...scenario,calls:[]};
      const {showAppWindow}=await import('/src/platform/desktop.ts');
      await showAppWindow();
      return window.sizing;
    }, scenario);
    expect(result.calls).toEqual(['size','center','show']);
    expect(result.result.width).toBe(800);
    expect(result.result.height).toBeLessThanOrEqual(Math.floor((scenario.workHeight-scenario.frame)/scenario.scale)-24);
    await page.setViewportSize({width:result.result.width,height:result.result.height});
    const fits=await page.locator('#content-scroll').evaluate(el=>el.scrollHeight<=el.clientHeight);
    expect(fits).toBe(scenario.workHeight/scenario.scale>800);
  }
  console.log('Passed: fit before reveal, normal/150% scaling without scrolling, and small-screen height cap.');
} finally {await browser.close();}
