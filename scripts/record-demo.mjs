// Records a captioned walkthrough of the live product as a backup demo video.
// The device account is pre-provisioned (key injected via localStorage) so the run never depends on the faucet.
// Usage: node scripts/record-demo.mjs <privateKey> [url]
import { chromium } from 'playwright';
import fs from 'node:fs';

const key = process.argv[2];
const base = (process.argv[3] || 'https://codeking-ai.github.io/nowproof/').replace(/#.*$/, '');
const url = base + (base.includes('?') ? '&' : '?') + 'demo=1';
fs.mkdirSync('demo', { recursive: true });

const W = 1440, H = 900;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: 'demo/raw', size: { width: W, height: H } } });
await ctx.addInitScript(k => { try { localStorage.setItem('nowproof_key', k); } catch {} }, key);
const page = await ctx.newPage();
const wait = ms => page.waitForTimeout(ms);
const cap = text => page.evaluate(t => {
  let el = document.getElementById('demoCap');
  if (!el) {
    el = document.createElement('div'); el.id = 'demoCap';
    el.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:99;background:rgba(110,84,255,.96);color:#fff;padding:12px 24px;border-radius:12px;font:600 21px system-ui,"Microsoft YaHei";box-shadow:0 12px 40px #000a;max-width:88%;text-align:center;transition:opacity .2s';
    document.body.appendChild(el);
  }
  el.textContent = t;
}, text);
const scroll = async (dy, steps = 12) => { for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, dy / steps); await wait(40); } };

// 1. Home
await page.goto(url);
await page.waitForFunction(() => document.getElementById('headBlock').textContent.startsWith('#'), null, { timeout: 30000 });
await cap('NowProof 此刻为证 —— 每一秒，都有区块为证');
await wait(3500);
await cap('右侧是实时 Monad 区块流：约 0.4 秒一个区块');
await wait(3500);
await scroll(520);
await cap('四类场景：车险理赔 · 签收打卡 · 二手交易 · 远程面签');
await wait(3500);

// 2. Photo
await page.click('a.scene[href*="s=car"]');
await page.waitForSelector('#btnCam');
await page.click('#btnCam');
await cap('照片模式：画面实时烧录最新区块号与哈希，水印自带证书编号');
await wait(4500);
await cap('按下快门 —— 照片指纹立即锚定到 Monad');
await page.click('#btnShutter');
await page.waitForFunction(() => document.getElementById('doneText').textContent.includes('照片已锚定'), null, { timeout: 60000 });
await cap(await page.textContent('#doneText'));
await wait(3500);
await page.click('#btnViewCert');
await page.waitForFunction(() => /verdict (ok|bad)/.test(document.getElementById('verdict').className), null, { timeout: 60000 });
await cap('存证证书：任何人拿到原件即可核验 —— 核验通过');
await wait(4000);
await scroll(420);
await wait(1500);
await cap('模拟一次修图……');
await page.click('#btnTamper');
await page.waitForFunction(() => /verdict bad/.test(document.getElementById('verdict').className), null, { timeout: 30000 });
await cap('任何修图都会被立即识破');
await wait(4000);

// 3. Video + challenge
await page.evaluate(() => { location.hash = '#/capture?s=kyc'; });
await page.waitForSelector('#btnShutter:not([disabled])');
await cap('视频模式 + 真人挑战：指令由区块哈希实时生成，无法预知');
await wait(4000);
await page.click('#btnShutter');
await page.waitForFunction(() => document.getElementById('sSession').textContent.startsWith('NP-'), null, { timeout: 60000 });
await cap('每 0.4 秒切一段，指纹逐段上链');
await page.click('.ledger summary');
await wait(5000);
await cap('每一段都被夹在「画面中的区块」与「上链区块」之间，时间窗约 2 秒');
await wait(7000);
await page.click('#btnShutter');
await page.waitForFunction(() => document.getElementById('doneText').textContent.includes('个片段已锚定'), null, { timeout: 60000 });
await cap(await page.textContent('#doneText'));
await wait(3000);
await page.click('#btnViewCert');
await page.waitForFunction(() => /verdict (ok|bad)/.test(document.getElementById('verdict').className), null, { timeout: 60000 });
await cap('逐段核验通过，每一段都可追溯到具体区块与交易');
await scroll(480);
await wait(4000);
await cap('篡改视频中的任意一段……');
await page.click('#btnTamper');
await page.waitForFunction(() => /verdict bad/.test(document.getElementById('verdict').className), null, { timeout: 30000 });
await cap('篡改位置精确到 0.4 秒');
await wait(4500);

// 4. Why Monad
await page.evaluate(() => { location.hash = '#/about'; });
await wait(800);
await cap('原理：两个区块夹住每一段画面 —— 不早于 N，不晚于 N+k');
await wait(4000);
await scroll(520);
await cap('时间窗 = 出块间隔 × k —— 链越快，证明越强');
await wait(4500);
await scroll(700);
await cap('视频不离开设备，链上只有指纹；无中心化后端');
await wait(4500);
await page.evaluate(() => { location.hash = '#/'; });
await cap('NowProof 此刻为证 · codeking-ai.github.io/nowproof');
await wait(3500);

const vpath = await page.video().path();
await ctx.close();
await browser.close();
fs.copyFileSync(vpath, 'demo/nowproof-demo.webm');
console.log('saved demo/nowproof-demo.webm');
