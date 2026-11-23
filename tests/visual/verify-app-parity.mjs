// FruityHash is the v1.0 reference. Compare the actual app's computed styles
// against the portable showcase, rather than maintaining a second CSS snapshot.
import { chromium, expect } from '@playwright/test';
const origin = process.env.FRUITY_APP_ORIGIN ?? 'http://127.0.0.1:1421';
const browser = await chromium.launch({channel:process.env.FRUITY_BROWSER_CHANNEL || undefined});
const properties = [
  'display','color','background-color','background-image','border-top-color',
  'border-top-width','border-top-style','border-radius','box-shadow','font-family',
  'font-size','font-weight','line-height','letter-spacing','text-shadow',
  'padding-top','padding-right','padding-bottom','padding-left','gap',
  'flex-direction','justify-content','align-items','min-height',
];
const snapshot = locator => locator.evaluate((node, properties) => {
  const style=getComputedStyle(node);
  return Object.fromEntries(properties.map(property=> {
    const value=style.getPropertyValue(property);
    // Grid/flex formatting contexts report an unconstrained minimum as auto;
    // block formatting reports 0px. Neither is a component styling difference.
    return [property,property==='min-height' && value==='auto' ? '0px' : value];
  }));
}, properties);
try {
  const app=await browser.newPage(), components=await browser.newPage(), workflow=await browser.newPage();
  await app.route('**/src/main.ts*',route=>route.fulfill({contentType:'application/javascript',body:'import "/tests/ui/app-fixture.ts";'}));
  await app.goto(origin);
  await components.goto(`${origin}/tests/visual/fruity.html`);
  await workflow.goto(`${origin}/tests/visual/workflow.html`);
  await expect(app.locator('#window-titlebar')).toBeVisible();
  const compare=async (source,page,target) => {
    expect(await snapshot(page.locator(target).first()), `${source} vs ${target}`).toEqual(await snapshot(app.locator(source).first()));
  };
  for(const width of [800,520,320]) {
    for(const page of [app,components,workflow]) await page.setViewportSize({width,height:900});
    await compare('.fr-panel--glass',components,'.fr-panel--glass');
    await compare('.fr-brand',components,'.fr-brand');
    await compare('.fr-brand__icon',components,'.fr-brand__icon');
    await compare('.fr-local-badge',components,'.fr-local-badge');
    await compare('.fr-step',components,'.fr-step');
    await compare('.fr-section-heading h2',components,'.fr-section-heading h2');
    await compare('.fr-empty--inline',components,'.fr-empty--inline');
    await compare('.fr-empty__emblem',components,'.fr-empty__emblem');
    await compare('#expected-checksum',components,'#expected-value');
    await compare('#expected-checksum',workflow,'#expected');
    await compare('#copy-all',components,'.fr-button--copy-all');
    await compare('.fr-choice--chip:has(input[value="sha256"])',components,'.fr-choice--chip:has(input[checked])');
    await compare('.fr-badge--subtle',components,'.fr-badge--subtle');
    await compare('#calculate',components,'.fr-button--hero:disabled');
    await compare('#dropzone',workflow,'#file-drop');
    await compare('#dropzone .fr-file-icon',workflow,'.fr-file-icon');
    await compare('#choose-file',workflow,'#fixture-choose');
    await compare('#operation',workflow,'#operation');
    await compare('#operation .fr-task__line',workflow,'#operation .fr-task__line');
    await compare('.fr-footer',workflow,'.fr-footer');
    await compare('.fr-footer__status',workflow,'.fr-footer__status');
    await compare('.fr-help-button',workflow,'.fr-help-button');
    await compare('#window-titlebar',workflow,'.fr-titlebar--glass');
    await compare('.fh-compare-panel > .fr-help',components,'#normal-help');
  }
  for(const page of [app,components,workflow]) await page.setViewportSize({width:800,height:900});
  await app.locator('#choose-file').click();
  await workflow.locator('#fixture-choose').click();
  await compare('#selected-file',workflow,'#selected-file');
  await compare('#clear-file',workflow,'#fixture-clear');
  await compare('#calculate',components,'.fr-button--hero:not(:disabled)');
  await app.locator('#calculate').click();
  await app.evaluate(()=>{
    window.fixture.send('started',{totalBytes:window.fixture.size});
    window.fixture.resolve(); window.fixture.progress();
  });
  await workflow.locator('#operation-state').selectOption('hashing');
  await expect(app.locator('#hash-progress')).toBeVisible();
  await compare('#hash-progress',workflow,'#operation-meter');
  await compare('#hash-progress',components,'#progress');
  const meterHeight=await app.locator('#hash-progress').evaluate(el=>getComputedStyle(el).height);
  expect(await components.locator('#progress').evaluate(el=>getComputedStyle(el).height)).toBe(meterHeight);
  await app.evaluate(()=>window.fixture.complete());
  await expect(app.locator('#results-list')).toBeVisible();
  await compare('#results-list .fr-value:not([hidden])',workflow,'.fr-value');
  await compare('#results-list .fr-value:not([hidden]) .fr-value__text',workflow,'.fr-value__text');
  const digest=await workflow.locator('#sha256-value').textContent();
  await app.locator('#expected-checksum').fill(digest);
  await workflow.locator('#fixture-match').click();
  await expect(app.locator('#comparison')).toHaveAttribute('data-state','match');
  await compare('#comparison',workflow,'#comparison-verdict');
  await compare('#comparison .fr-verdict__message',workflow,'.fr-verdict__message');
  await compare('#comparison .fr-verdict__badge',workflow,'.fr-verdict__badge');
  await app.locator('#help').click();
  await workflow.getByRole('button',{name:'Help & About'}).click();
  await compare('#help-dialog',workflow,'#help-dialog');
  await compare('#help-dialog .fr-about-header',workflow,'.fr-about-header');
  await compare('#help-dialog .fr-about-header img',workflow,'.fr-about-header img');
  for(const page of [app,components,workflow]) await page.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});
  await compare('#help-dialog',workflow,'#help-dialog');
  await compare('.fh-compare-panel > .fr-help',components,'#normal-help');
  await app.keyboard.press('Escape');
  for(const page of [app,components,workflow]) await page.emulateMedia({forcedColors:'none',reducedMotion:'no-preference'});
  await app.locator('#calculate').click();
  await app.evaluate(()=>window.fixture.close());
  await expect(app.locator('#close-dialog')).toBeVisible();
  await components.getByRole('button',{name:'Open dialog',exact:true}).click();
  await compare('#close-dialog',components,'#preview-dialog');
  await compare('#close-dialog .fr-dialog__header',components,'#preview-dialog .fr-dialog__header');
  console.log('Passed: app/showcase visual parity for used components at 800/520/320px, enabled/disabled actions, selected file, results, match verdict, About and accessibility preferences.');
} finally {await browser.close();}
