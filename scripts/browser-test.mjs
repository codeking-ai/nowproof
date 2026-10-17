// Headless self-test of the full product flow with a fake camera:
// home -> capture (challenge mode) -> certificate auto-verify -> tamper test -> records.
// Usage: node scripts/browser-test.mjs [url] [seconds]
import { chromium } from 'playwright';
import fs from 'node:fs';

const base = (process.argv[2] || 'http://localhost:5173/').replace(/#.*$/, '');
const secs = Number(process.argv[3] || 6);
fs.mkdirSync('.tmp', { recursive: true });

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, permissions: ['camera'] });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
const text = async sel => (await page.textContent(sel)).replace(/\s+/g, ' ').trim();

await page.goto(base);
await page.waitForFunction(() => document.getElementById('headBlock').textContent.startsWith('#'), null, { timeout: 20000 });
await page.waitForTimeout(2500);
console.log('home: block', await text('#stBlock'), 'sessions', await text('#stSessions'));
await page.screenshot({ path: '.tmp/home.png' });

await page.goto(base + '#/capture?s=kyc');
await page.click('#btnCam');
await page.waitForSelector('#btnShutter:not([disabled])');
await page.click('#btnShutter');
await page.waitForFunction(() => document.getElementById('sSession').textContent.startsWith('NP-'), null, { timeout: 60000 });
console.log('capture: cert', await text('#sSession'), 'challenge', await page.isChecked('#chkChallenge'));
await page.waitForTimeout(secs * 1000);
await page.screenshot({ path: '.tmp/capture.png' });
await page.click('#btnShutter');
await page.waitForFunction(() => document.getElementById('doneText').textContent.includes('已锚定'), null, { timeout: 60000 });
console.log('done:', await text('#doneText'));
await page.screenshot({ path: '.tmp/done.png' });

await page.click('#btnViewCert');
await page.waitForFunction(() => /verdict (ok|bad)/.test(document.getElementById('verdict').className), null, { timeout: 60000 });
console.log('cert:', await text('#certNo'), '|', await text('#cScene'), '|', await text('#cBlocks'), '|', await text('#cWin'));
console.log('verify:', await text('#verdict'), '| status', await text('#certStatus'));
await page.waitForTimeout(1500);
await page.screenshot({ path: '.tmp/cert.png', fullPage: true });
await page.click('#btnTamper');
await page.waitForFunction(() => /verdict bad/.test(document.getElementById('verdict').className), null, { timeout: 30000 });
console.log('tamper:', await text('#verdict'));
await page.screenshot({ path: '.tmp/tamper.png', fullPage: true });

await page.goto(base + '#/records');
await page.waitForTimeout(500);
console.log('records:', await page.locator('.rec-item').count(), 'items');
await page.screenshot({ path: '.tmp/records.png' });
await page.goto(base + '#/about');
await page.screenshot({ path: '.tmp/about.png', fullPage: true });

console.log('console errors:', errors.length ? errors : 'none');
await browser.close();
