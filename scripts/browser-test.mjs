// Headless self-test of the full user flow with a fake camera:
// open camera -> record N seconds (anchoring to Monad) -> verify -> simulate tamper -> verify again.
// Usage: node scripts/browser-test.mjs [url] [seconds]
import { chromium } from 'playwright';
import fs from 'node:fs';

const url = process.argv[2] || 'http://localhost:5173/';
const secs = Number(process.argv[3] || 6);
fs.mkdirSync('.tmp', { recursive: true });

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, permissions: ['camera'] });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

await page.goto(url);
await page.waitForFunction(() => document.getElementById('headBlock').textContent !== '#…', null, { timeout: 20000 });
console.log('head', await page.textContent('#headBlock'), 'wallet', await page.getAttribute('#wAddr', 'title'));
await page.click('#btnCam');
await page.waitForSelector('#btnStart:not([disabled])');
await page.click('#btnStart');
await page.waitForFunction(() => /^\d+$/.test(document.getElementById('sSession').textContent), null, { timeout: 60000 });
console.log('session', await page.textContent('#sSession'));
await page.waitForTimeout(secs * 1000);
await page.screenshot({ path: '.tmp/record.png' });
await page.click('#btnStop');
await page.waitForSelector('#doneBox:not([hidden])', { timeout: 30000 });
await page.waitForFunction(() => document.getElementById('sOk').textContent === document.getElementById('sSent').textContent, null, { timeout: 30000 }).catch(() => {});
console.log('sent', await page.textContent('#sSent'), 'ok', await page.textContent('#sOk'), 'avg window', await page.textContent('#sWin'));
await page.click('#btnVerifyNow');
await page.waitForFunction(() => /verdict (ok|bad)/.test(document.getElementById('verdict').className), null, { timeout: 60000 });
console.log('VERIFY:', (await page.textContent('#verdict')).replace(/\s+/g, ' ').slice(0, 200));
await page.screenshot({ path: '.tmp/verify.png', fullPage: true });
await page.click('#btnTamper');
await page.waitForFunction(() => /verdict bad/.test(document.getElementById('verdict').className), null, { timeout: 30000 });
console.log('TAMPER:', (await page.textContent('#verdict')).replace(/\s+/g, ' ').slice(0, 200));
await page.screenshot({ path: '.tmp/tamper.png', fullPage: true });
console.log('console errors:', errors.length ? errors : 'none');
await browser.close();
