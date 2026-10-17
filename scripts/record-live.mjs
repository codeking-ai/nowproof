// Records the full product walkthrough with the REAL webcam in a visible browser window,
// so a presenter can sit in front of the camera and follow the challenge prompts.
// Usage: node scripts/record-live.mjs <privateKey> [videoSeconds=64] [url]
import { chromium } from 'playwright';
import fs from 'node:fs';

const key = process.argv[2];
const SECS = Number(process.argv[3] || 64);
const base = (process.argv[4] || 'https://codeking-ai.github.io/nowproof/').replace(/#.*$/, '');
fs.mkdirSync('demo', { recursive: true });

const W = 1440, H = 860;
const browser = await chromium.launch({ headless: false, args: ['--use-fake-ui-for-media-stream', `--window-size=${W},${H + 90}`, '--window-position=0,0'] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, permissions: ['camera'], recordVideo: { dir: 'demo/raw-live', size: { width: W, height: H } } });
await ctx.addInitScript(k => { try { localStorage.setItem('nowproof_key', k); } catch {} }, key);
const page = await ctx.newPage();
const wait = ms => page.waitForTimeout(ms);
const cap = text => page.evaluate(t => {
  let el = document.getElementById('demoCap');
  if (!el) {
    el = document.createElement('div'); el.id = 'demoCap';
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99;background:rgba(110,84,255,.96);color:#fff;padding:12px 24px;border-radius:12px;font:600 21px system-ui,"Microsoft YaHei";box-shadow:0 12px 40px #000a;max-width:88%;text-align:center';
    document.body.appendChild(el);
  }
  el.textContent = t;
}, text);
const scroll = async (dy, steps = 12) => { for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, dy / steps); await wait(40); } };
const countdown = async (label, n) => { for (let i = n; i > 0; i--) { await cap(`${label} ${i}`); await wait(1000); } };

// 0. Get ready
await page.goto(base);
await page.waitForFunction(() => document.getElementById('headBlock').textContent.startsWith('#'), null, { timeout: 30000 });
await countdown('真人录制即将开始，请坐到摄像头前 ·', 8);

// 1. Home
await cap('NowProof 此刻为证 —— 每一秒，都有区块为证');
await wait(3500);
await cap('右侧是实时 Monad 区块流：约 0.4 秒一个区块');
await wait(3500);

// 2. Photo with a real object
await page.goto(base + '#/capture?s=car&m=photo');
for (let attempt = 0; attempt < 3; attempt++) {
  await page.click('#btnCam');
  await page.waitForFunction(() => !document.getElementById('btnShutter').disabled || !document.getElementById('camMsg').hidden, null, { timeout: 20000 });
  if (!(await page.isDisabled('#btnShutter'))) break;
  console.error('camera attempt', attempt + 1, 'failed:', await page.textContent('#camMsg'));
  if (attempt === 2) process.exit(1);
  await wait(1500);
}
await cap('照片模式：请把手机或身边的物品举到镜头前');
await wait(5000);
await countdown('画面已烧录最新区块与证书编号 · 拍照倒计时', 3);
await page.click('#btnShutter');
await page.waitForFunction(() => document.getElementById('doneText').textContent.includes('照片已锚定'), null, { timeout: 60000 });
await cap(await page.textContent('#doneText'));
await wait(3500);
await page.click('#btnViewCert');
await page.waitForFunction(() => /verdict (ok|bad)/.test(document.getElementById('verdict').className), null, { timeout: 60000 });
await cap('存证证书：持原件即可核验 —— 核验通过');
await wait(3500);
await scroll(420);
await wait(1500);
await cap('模拟一次修图……');
await page.click('#btnTamper');
await page.waitForFunction(() => /verdict bad/.test(document.getElementById('verdict').className), null, { timeout: 30000 });
await cap('任何修图都会被立即识破');
await wait(4000);

// 3. Video + challenge with the presenter
await page.evaluate(() => { location.hash = '#/capture?s=kyc'; });
await page.waitForSelector('#btnShutter:not([disabled])');
await cap('视频模式 + 真人挑战：请看着摄像头，照画面上方的指令做动作、念出数字');
await wait(4500);
await countdown('约 8 秒换一条指令 · 开始录制', 3);
await page.click('#btnShutter');
await page.waitForFunction(() => document.getElementById('sSession').textContent.startsWith('NP-'), null, { timeout: 60000 });
const t0 = Date.now();
let opened = false;
while (Date.now() - t0 < SECS * 1000) {
  const s = Math.floor((Date.now() - t0) / 1000);
  if (!opened && s >= 12) { await page.click('.ledger summary'); opened = true; }
  const ok = await page.textContent('#sOk');
  await cap(`请照指令做动作、念出数字 · 已录制 ${s}s / ${SECS}s · 已锚定 ${ok} 段`);
  await wait(1000);
}
await page.click('#btnShutter');
await cap('停止录制，等待最后的片段上链……');
await page.waitForFunction(() => document.getElementById('doneText').textContent.includes('个片段已锚定'), null, { timeout: 90000 });
await cap(await page.textContent('#doneText'));
await wait(3500);
await page.click('#btnViewCert');
await page.waitForFunction(() => /verdict (ok|bad)/.test(document.getElementById('verdict').className), null, { timeout: 90000 });
const verdict1 = await page.textContent('#verdict');
await cap('逐段核验通过：每一段都可追溯到具体区块、交易与挑战指令');
await scroll(480);
await wait(3000);
// step through a few challenge checkpoints on the timeline
const cells = await page.locator('.timeline .c').count();
for (const f of [0.12, 0.35, 0.6, 0.85]) {
  await page.locator('.timeline .c').nth(Math.floor(cells * f)).click();
  await cap('点击时间轴：查看该时刻的画面区块、时间窗与挑战指令');
  await wait(2500);
}
await cap('篡改视频中的任意一段……');
await page.click('#btnTamper');
await page.waitForFunction(() => /verdict bad/.test(document.getElementById('verdict').className), null, { timeout: 30000 });
await cap('篡改位置精确到 0.4 秒');
await wait(4500);
await scroll(-900);
await cap('对比：用另一段视频冒充这份证书……');
await wait(2500);
await page.setInputFiles('#vFile', 'demo/assets/other-video.webm');
await page.waitForFunction(() => document.getElementById('verdict').textContent.includes('不匹配'), null, { timeout: 30000 });
await cap('核验未通过：文件与本证书不匹配，冒充无效');
await wait(5000);

// 4. Why Monad
await page.evaluate(() => { location.hash = '#/about'; });
await wait(800);
await cap('原理：两个区块夹住每一段画面 —— 不早于 N，不晚于 N+k');
await wait(4000);
await scroll(520);
await cap('时间窗 = 出块间隔 × k —— 链越快，证明越强');
await wait(4500);
await page.evaluate(() => { location.hash = '#/'; });
await cap('NowProof 此刻为证 · codeking-ai.github.io/nowproof');
await wait(3500);

const vpath = await page.video().path();
await ctx.close();
await browser.close();
fs.copyFileSync(vpath, 'demo/nowproof-live.webm');
console.log('verify:', verdict1.replace(/\s+/g, ' '));
console.log('saved demo/nowproof-live.webm');
