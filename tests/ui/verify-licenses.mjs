import { chromium, expect } from '@playwright/test';
import fs from 'node:fs';
const browser=await chromium.launch({channel:process.env.FRUITY_BROWSER_CHANNEL || undefined});
const page=await browser.newPage({viewport:{width:800,height:800}});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
try {
  const project=fs.readFileSync('LICENSE','utf8');
  const notices=fs.readFileSync('THIRD_PARTY_NOTICES.txt','utf8');
  expect(fs.readFileSync('src/styles/fruity/LICENSE','utf8')).toBe(project);
  expect(JSON.parse(fs.readFileSync('package.json','utf8')).license).toBe('MIT');
  const config=JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json','utf8'));
  expect(config.bundle.resources['../THIRD_PARTY_NOTICES.txt']).toBe('THIRD_PARTY_NOTICES.txt');
  await page.goto(process.env.FRUITY_APP_ORIGIN ?? 'http://127.0.0.1:1421/');
  await page.getByRole('button',{name:'Help and about FruityHash'}).click();
  const metadata=page.locator('#app-version').locator('..');
  await expect(metadata.locator('br')).toHaveCount(2);
  expect(await page.locator('#ui-version').evaluate(el=>el.getBoundingClientRect().top))
    .toBeGreaterThan(await page.locator('#app-version').evaluate(el=>el.getBoundingClientRect().top));
  await expect(page.locator('#license-notices')).toBeHidden();
  await page.getByText('Licenses and notices',{exact:true}).click();
  await expect(page.locator('#license-notices')).toBeVisible();
  await expect(page.locator('#license-notices')).toHaveValue(`${project}\n\n${notices}`);
  await expect(page.locator('#license-notices')).toHaveAttribute('readonly','');
  for(const width of [800,320]) {
    await page.setViewportSize({width,height:800});
    expect(await page.locator('#help-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  }
  expect(errors).toEqual([]);
  console.log('Passed: portable MIT license, installer notice resources, and complete offline license display at desktop/narrow widths.');
} finally {await browser.close();}
