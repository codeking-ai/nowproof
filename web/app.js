import {
  createPublicClient, http, keccak256, parseEventLogs, formatEther, encodeFunctionData,
  privateKeyToAccount, generatePrivateKey, monadTestnet,
} from './vendor.js';

const RPC = 'https://testnet-rpc.monad.xyz';
const WSS = 'wss://testnet-rpc.monad.xyz';
const FAUCET = 'https://agents.devnads.com/v1/faucet';
const EXPLORER = 'https://testnet.monadexplorer.com';
const SLICE_MS = 400;          // one video segment per Monad block time
const GAS_START = 150000n;
const GAS_ANCHOR = 45000n;     // measured ~35.2k; Monad bills the gas limit, keep it tight
const LOG_RANGE = 100;         // testnet RPC caps eth_getLogs at 100 blocks
const CH_BUCKET = 8n;          // challenge rotates every 8 blocks (~3.2s)

const SCENES = {
  general: { name: '通用存证', ic: '🎥' },
  car: { name: '车险理赔', ic: '🚗' },
  parcel: { name: '签收打卡', ic: '📦' },
  trade: { name: '二手交易', ic: '🔍' },
  kyc: { name: '远程面签', ic: '🧑‍💼' },
};
const ACTIONS = ['向左转头', '向右转头', '眨眼两次', '缓慢点头', '举起右手', '举起左手', '比出数字 3', '比出数字 5', '手掌遮住半边脸', '抬头看上方', '张嘴微笑', '竖起大拇指'];
const challengeOf = hash => {
  const n = parseInt(hash.slice(2, 10), 16);
  return { action: ACTIONS[n % ACTIONS.length], code: String(parseInt(hash.slice(10, 16), 16) % 10000).padStart(4, '0') };
};

const cfg = await fetch('./contract.json').then(r => r.json());
const abi = cfg.abi;
const pub = createPublicClient({ chain: monadTestnet, transport: http(RPC, { batch: false }) });

const $ = id => document.getElementById(id);
const short = (h, a = 6, b = 4) => h ? `${h.slice(0, a)}…${h.slice(-b)}` : '—';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const certNo = id => `NP-${String(id).padStart(6, '0')}`;
function toast(msg, ms = 3000) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
for (const id of ['cContract', 'footContract']) $(id).href = `${EXPLORER}/address/${cfg.address}`;
$('cContract').textContent = short(cfg.address, 8, 6);

// ---------------------------------------------------------------- local storage
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('nowproof', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('videos');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function saveVideo(id, blob) {
  try { const db = await idb(); await new Promise(r => { const tx = db.transaction('videos', 'readwrite'); tx.objectStore('videos').put(blob, String(id)); tx.oncomplete = r; tx.onerror = r; }); } catch {}
}
async function loadVideo(id) {
  try { const db = await idb(); return await new Promise(r => { const q = db.transaction('videos').objectStore('videos').get(String(id)); q.onsuccess = () => r(q.result || null); q.onerror = () => r(null); }); } catch { return null; }
}

// ---------------------------------------------------------------- router
const routes = { home: 'home', capture: 'capture', records: 'records', proof: 'proof', about: 'about' };
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const [name, arg] = path.split('/');
  return { name: routes[name] || 'home', arg, q: new URLSearchParams(qs || '') };
}
function route() {
  const r = parseHash();
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${r.name}`));
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === r.name));
  window.scrollTo(0, 0);
  if (r.name === 'home') refreshSessionCount();
  if (r.name === 'capture') enterCapture(r.q.get('s'), r.q.get('m'));
  if (r.name === 'records') renderRecords();
  if (r.name === 'proof') openProof(r.arg);
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- live chain head
let head = null;               // { number: bigint, hash, at: ms }
const blockTimes = [];
// New blocks are pushed over a WebSocket newHeads subscription; HTTP polling is only a fallback.
// Nothing runs while the tab is hidden (unless a recording is in progress).
let ws = null, pollTimer = null, wsRetry = null;
function ingestHead(number, hash) {
  if (head && number <= head.number) return;
  const now = performance.now();
  if (head) {
    blockTimes.push((now - head.at) / Number(number - head.number));
    if (blockTimes.length > 30) blockTimes.shift();
  }
  head = { number, hash, at: now };
  document.querySelector('.chain .dot').classList.add('live');
  onHead(head);
}
function connectHeads() {
  if (ws || (document.hidden && !rec)) return;
  try { ws = new WebSocket(WSS); } catch { ws = null; return startPolling(); }
  ws.onopen = () => { stopPolling(); ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] })); };
  ws.onmessage = e => {
    const h = JSON.parse(e.data).params?.result;
    if (h?.number) ingestHead(BigInt(h.number), h.hash);
  };
  ws.onclose = () => {
    ws = null;
    if (document.hidden && !rec) return;
    startPolling();
    clearTimeout(wsRetry); wsRetry = setTimeout(connectHeads, 5000);
  };
}
function startPolling() {
  if (pollTimer) return;
  const tick = async () => {
    try { const b = await pub.getBlock({ blockTag: 'latest' }); ingestHead(b.number, b.hash); }
    catch { document.querySelector('.chain .dot').classList.remove('live'); }
    const fast = rec || ['home', 'capture'].includes(parseHash().name);
    pollTimer = setTimeout(tick, fast ? 250 : 2000);
  };
  pollTimer = setTimeout(tick, 0);
}
function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !rec) { stopPolling(); clearTimeout(wsRetry); if (ws) { ws.onclose = null; ws.close(); ws = null; } }
  else if (!document.hidden) connectHeads();
});
function onHead(b) {
  $('headBlock').textContent = `#${b.number}`;
  $('stBlock').textContent = Number(b.number).toLocaleString();
  const avg = blockTimes.length > 3 ? blockTimes.reduce((a, c) => a + c, 0) / blockTimes.length / 1000 : null;
  if (avg) $('blockTime').textContent = `${avg.toFixed(2)} s`;
  const t = new Date();
  const el = document.createElement('div');
  el.className = 'hc-blk';
  el.innerHTML = `<b>#${b.number}</b><span>${b.hash}</span><small>${t.toLocaleTimeString('zh-CN', { hour12: false })}.${String(t.getMilliseconds()).padStart(3, '0')}</small>`;
  const box = $('heroBlocks'); box.prepend(el);
  while (box.children.length > 7) box.lastChild.remove();
  updateChallenge();
}
async function refreshSessionCount() {
  try { $('stSessions').textContent = Number(await pub.readContract({ address: cfg.address, abi, functionName: 'sessionCount' })).toLocaleString(); } catch {}
}

// ---------------------------------------------------------------- account (auto-provisioned)
function loadKey() {
  let k = null;
  try { k = localStorage.getItem('nowproof_key'); } catch {}
  if (!k) { k = generatePrivateKey(); try { localStorage.setItem('nowproof_key', k); } catch {} }
  return k;
}
const account = privateKeyToAccount(loadKey());
$('wAddr').textContent = short(account.address, 6, 4);
$('wAddr').title = account.address;
let balance = 0n;
async function refreshBalance() {
  try { balance = await pub.getBalance({ address: account.address }); $('wBal').textContent = `${Number(formatEther(balance)).toFixed(3)} MON`; } catch {}
  return balance;
}
let funding = null;
function ensureFunds(min = 50000000000000000n) {
  if (funding) return funding;
  funding = (async () => {
    if ((await refreshBalance()) >= min) return true;
    try {
      const r = await fetch(FAUCET, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chainId: 10143, address: account.address }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const before = balance;
      for (let i = 0; i < 20 && (await refreshBalance()) <= before; i++) await sleep(500);
    } catch {}
    return balance >= 20000000000000000n;
  })().finally(() => { funding = null; });
  return funding;
}

let nonce = null, gasPrice = null;
async function sendTx(data, gas) {
  if (gasPrice === null) gasPrice = await pub.getGasPrice();
  if (nonce === null) nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
  const n = nonce++;
  const raw = await account.signTransaction({ type: 'legacy', chainId: monadTestnet.id, to: cfg.address, data, gas, gasPrice, nonce: n });
  try { return await pub.request({ method: 'eth_sendRawTransaction', params: [raw] }); }
  catch (e) { nonce = null; throw e; }
}

// ---------------------------------------------------------------- capture view
let scene = 'general';
function renderChips() {
  $('sceneChips').innerHTML = '';
  for (const [k, s] of Object.entries(SCENES)) {
    const b = document.createElement('button');
    b.className = `chip ${k === scene ? 'on' : ''}`; b.textContent = `${s.ic} ${s.name}`;
    b.onclick = () => { if (rec) return; scene = k; if (k === 'kyc') $('chkChallenge').checked = true; renderChips(); };
    $('sceneChips').appendChild(b);
  }
}
function enterCapture(s, m) {
  if (s && SCENES[s] && !rec) { scene = s; $('chkChallenge').checked = s === 'kyc'; }
  renderChips();
  setMode(m === 'photo' ? 'photo' : (s ? 'video' : mode));
  ensureFunds();
}

// Capture mode: 'video' (one anchor per 0.4s segment) or 'photo' (one anchor per shot).
let mode = 'video';
function setMode(m) {
  if (rec || shooting) return;
  mode = m;
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  $('btnShutter').classList.toggle('photo', m === 'photo');
  if (m === 'photo' && source) prepareSession();
}
document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => setMode(b.dataset.m));

// Photo sessions are opened ahead of the shot, so the shutter only has to send one anchor tx
// and the watermark can already carry the certificate number.
let prepared = null, shooting = false;
function prepareSession() {
  const c = $('chkChallenge').checked;
  if (prepared && prepared.c === c) return prepared.p;
  const entry = { c, id: null };
  entry.p = (async () => {
    if (!(await ensureFunds())) throw new Error('funds');
    const hash = await sendTx(encodeFunctionData({ abi, functionName: 'start', args: [JSON.stringify({ v: 1, c: c ? 1 : 0, m: 'p' })] }), GAS_START);
    const rc = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 });
    entry.id = parseEventLogs({ abi, logs: rc.logs, eventName: 'SessionStarted' })[0].args.id;
    return entry.id;
  })();
  entry.p.catch(() => { if (prepared === entry) prepared = null; });
  prepared = entry;
  return entry.p;
}

const canvas = $('cam'), ctx = canvas.getContext('2d');
const video = document.createElement('video');
video.muted = true; video.playsInline = true;
let source = null, rec = null, drawnMin = null, lastDrawn = null;

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream; await video.play();
    source = 'camera';
  } catch {
    source = 'synthetic';
  }
  const w = source === 'camera' ? video.videoWidth : 1280, h = source === 'camera' ? video.videoHeight : 720;
  const scale = Math.min(1, 1280 / w);
  canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
  $('camEmpty').hidden = true;
  $('btnShutter').disabled = false;
  requestAnimationFrame(draw);
  if (mode === 'photo') prepareSession();
}
$('btnCam').onclick = startCamera;

function drawSynthetic(t) {
  const W = canvas.width, H = canvas.height;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1a1530'); g.addColorStop(1, '#0d2230');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 6; i++) {
    const x = W / 2 + Math.cos(t / 900 + i) * W * 0.3, y = H * 0.42 + Math.sin(t / 700 + i * 2) * H * 0.22;
    ctx.beginPath(); ctx.arc(x, y, 40 + 18 * Math.sin(t / 400 + i), 0, 7);
    ctx.fillStyle = `hsla(${(i * 55 + t / 30) % 360},80%,60%,.55)`; ctx.fill();
  }
}

// Challenge: derived from the hash of the first block of each 8-block bucket.
let challenge = null;          // { bucket, block, action, code }
const bucketHashes = new Map();
async function updateChallenge() {
  if (!head || !$('chkChallenge').checked) return;
  const bucket = head.number / CH_BUCKET;
  if (challenge && challenge.bucket === bucket) return;
  const bn = bucket * CH_BUCKET;
  let hash = bn === head.number ? head.hash : bucketHashes.get(bn);
  if (!hash) {
    if (bucketHashes.has(`p${bn}`)) return;
    bucketHashes.set(`p${bn}`, 1);
    try { hash = (await pub.getBlock({ blockNumber: bn })).hash; } catch { return; }
  }
  bucketHashes.set(bn, hash);
  if (head.number / CH_BUCKET !== bucket) return;
  challenge = { bucket, block: bn, ...challengeOf(hash), at: performance.now() };
}

function draw(t) {
  const W = canvas.width, H = canvas.height;
  if (source === 'camera') ctx.drawImage(video, 0, 0, W, H); else drawSynthetic(t);
  const band = Math.round(H * 0.15), pad = Math.round(H * 0.03);
  ctx.fillStyle = 'rgba(8,8,14,.78)'; ctx.fillRect(0, H - band, W, band);
  ctx.fillStyle = '#836ef9'; ctx.fillRect(0, H - band, 6, band);
  if (head) {
    if (rec && (!drawnMin || head.number < drawnMin.number)) drawnMin = { number: head.number, hash: head.hash };
    lastDrawn = { number: head.number, hash: head.hash };
    ctx.fillStyle = '#ffd166'; ctx.font = `700 ${Math.round(band * 0.36)}px ui-monospace,Consolas,monospace`;
    ctx.fillText(`MONAD #${head.number}`, pad + 6, H - band + band * 0.45);
    ctx.fillStyle = '#ecebf5'; ctx.font = `500 ${Math.round(band * 0.24)}px ui-monospace,Consolas,monospace`;
    ctx.fillText(head.hash.slice(0, 18), pad + 6, H - band + band * 0.8);
  }
  const now = new Date();
  const ts = now.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
  ctx.textAlign = 'right';
  ctx.fillStyle = '#ecebf5'; ctx.font = `600 ${Math.round(band * 0.26)}px ui-monospace,Consolas,monospace`;
  ctx.fillText(ts, W - pad, H - band + band * 0.45);
  ctx.fillStyle = '#9a98b3'; ctx.font = `500 ${Math.round(band * 0.2)}px system-ui`;
  const tagline = rec?.id ? `NowProof · ${certNo(rec.id)} · #${rec.seq}`
    : mode === 'photo' && prepared?.id ? `NowProof · ${certNo(prepared.id)}` : `NowProof · ${SCENES[scene].name}`;
  ctx.fillText(tagline, W - pad, H - band + band * 0.8);
  ctx.textAlign = 'left';

  if ($('chkChallenge').checked && challenge) {
    const bw = Math.min(W * 0.62, 640), bh = Math.round(H * 0.13), bx = (W - bw) / 2, by = Math.round(H * 0.05);
    ctx.fillStyle = 'rgba(110,84,255,.88)';
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 14); ctx.fill();
    const p = Math.min(1, (performance.now() - challenge.at) / 3200);
    ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(bx + 14, by + bh - 8, (bw - 28) * (1 - p), 3);
    ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
    ctx.font = `700 ${Math.round(bh * 0.36)}px system-ui`;
    ctx.fillText(`${challenge.action} · 念出 ${challenge.code}`, W / 2, by + bh * 0.52);
    ctx.font = `500 ${Math.round(bh * 0.17)}px ui-monospace,Consolas,monospace`; ctx.fillStyle = '#e6e0ff';
    ctx.fillText(`真人挑战 · 区块 #${challenge.block}`, W / 2, by + bh * 0.8);
    ctx.textAlign = 'left';
  }
  if (rec) {
    const s = (performance.now() - rec.t0) / 1000;
    $('recTime').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  }
  requestAnimationFrame(draw);
}
$('chkChallenge').onchange = () => { challenge = null; updateChallenge(); if (mode === 'photo' && source && !shooting) prepareSession(); };

// ---------------------------------------------------------------- recording
const feedRows = new Map();
function feedRow(seq, size, hash, seen) {
  const el = document.createElement('div');
  el.className = 'ln';
  el.innerHTML = `<span>#${seq}</span><span class="sz">${(size / 1024).toFixed(1)} KB</span><span class="h">${short(hash, 14, 8)}</span><span class="tx">#${seen} → …</span><span class="st pend">发送中</span>`;
  $('feed').appendChild(el); $('feed').scrollTop = 1e9;
  feedRows.set(seq, el);
}
function setRow(seq, cls, text, sandwich) {
  const el = feedRows.get(seq); if (!el) return;
  const st = el.querySelector('.st'); st.className = `st ${cls}`; st.textContent = text;
  if (sandwich) el.querySelector('.tx').textContent = sandwich;
}
function updateStats() {
  $('sOk').textContent = rec.ok; $('lmOk').textContent = rec.ok;
  if (rec.ok) { const w = `${(rec.lagSum / rec.ok * 0.4).toFixed(1)}s`; $('sWin').textContent = w; $('lmWin').textContent = w; }
}

async function startRecording() {
  $('btnShutter').disabled = true;
  if (!head) { $('btnShutter').disabled = false; return toast('正在连接网络，请稍候'); }
  if (!(await ensureFunds())) { $('btnShutter').disabled = false; return toast('存证账户初始化失败，请稍后重试'); }
  rec = { id: null, seq: 0, offset: 0, chunks: [], sent: 0, ok: 0, lagSum: 0, pending: new Map(), t0: performance.now(), chain: Promise.resolve(), stopped: false, scene, challenge: $('chkChallenge').checked };
  $('feed').innerHTML = '<div class="ln hd"><span>片段</span><span class="sz">大小</span><span class="h">指纹</span><span>区块</span><span class="st">状态</span></div>';
  feedRows.clear();
  $('doneBox').hidden = true; $('sSession').textContent = '创建中…'; $('sOk').textContent = '0'; $('sWin').textContent = '—';
  try {
    const label = JSON.stringify({ v: 1, c: rec.challenge ? 1 : 0 });   // no business data on-chain; scene stays local
    const hash = await sendTx(encodeFunctionData({ abi, functionName: 'start', args: [label] }), GAS_START);
    const rc = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 });
    rec.id = parseEventLogs({ abi, logs: rc.logs, eventName: 'SessionStarted' })[0].args.id;
    rec.scanFrom = rc.blockNumber;
  } catch (e) { rec = null; $('btnShutter').disabled = false; $('sSession').textContent = '—'; return toast('创建存证失败，请重试'); }
  $('sSession').textContent = certNo(rec.id);

  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m)) || '';
  rec.mime = mime || 'video/webm';
  const mr = new MediaRecorder(canvas.captureStream(30), { mimeType: mime, videoBitsPerSecond: 1_500_000 });
  rec.mr = mr;
  drawnMin = null;
  mr.ondataavailable = e => {
    if (!e.data.size) return;
    const seen = drawnMin; drawnMin = head ? { number: head.number, hash: head.hash } : null;
    const seq = rec.seq++, offset = rec.offset; rec.offset += e.data.size;
    rec.chunks.push(e.data);
    rec.chain = rec.chain.then(() => anchorChunk(seq, offset, e.data, seen));
  };
  mr.onstop = async () => { await rec.chain; finishRecording(); };
  rec.t0 = performance.now();
  mr.start(SLICE_MS);
  $('recBadge').hidden = false; $('liveMeter').hidden = false;
  $('btnShutter').classList.add('rec'); $('btnShutter').disabled = false;
  scanLoop(rec);
}

async function anchorChunk(seq, offset, blob, seen) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hash = keccak256(bytes);
  if (!seen) seen = { number: head.number, hash: head.hash };
  feedRow(seq, bytes.length, hash, seen.number);
  try {
    const tx = await sendTx(encodeFunctionData({ abi, functionName: 'anchor',
      args: [rec.id, seq, hash, BigInt(offset), bytes.length, seen.number, seen.hash] }), GAS_ANCHOR);
    rec.pending.set(seq, { tx, sentAt: head.number });
    rec.sent++;
    setRow(seq, 'pend', '确认中');
  } catch { setRow(seq, 'bad', '发送失败'); }
}

// One getLogs call per tick confirms every anchored segment (cheaper than polling receipts).
async function scanLoop(r) {
  while (r === rec && (!r.stopped || r.pending.size)) {
    await sleep(700);
    if (!head || r.scanFrom > head.number) continue;
    const to = head.number < r.scanFrom + BigInt(LOG_RANGE - 1) ? head.number : r.scanFrom + BigInt(LOG_RANGE - 1);
    try {
      const logs = await pub.getContractEvents({ address: cfg.address, abi, eventName: 'Anchored', args: { id: r.id }, fromBlock: r.scanFrom, toBlock: to });
      for (const l of logs) {
        const a = l.args, seq = Number(a.seq);
        if (!r.pending.has(seq)) continue;
        r.pending.delete(seq);
        const lag = Number(a.anchorBlock - a.seenBlock);
        r.ok++; r.lagSum += lag;
        setRow(seq, 'ok', `✓ ${(lag * 0.4).toFixed(1)}s`, `#${a.seenBlock} → #${a.anchorBlock}`);
      }
      r.scanFrom = to + 1n;
      for (const [seq, p] of r.pending) {
        if (head.number > p.sentAt + 25n) {
          r.pending.delete(seq);
          setRow(seq, 'bad', '✗ 未上链');
        }
      }
      updateStats();
    } catch {}
  }
}

function stopRecording() {
  if (!rec || !rec.mr || rec.stopped) return;
  rec.stopped = true;
  $('btnShutter').disabled = true;
  rec.mr.stop();
  $('recBadge').hidden = true;
}
$('btnShutter').onclick = () => mode === 'photo' ? takePhoto() : (rec && !rec.stopped ? stopRecording() : startRecording());

async function takePhoto() {
  if (shooting) return;
  if (!head) return toast('正在连接网络，请稍候');
  shooting = true; $('btnShutter').disabled = true;
  $('doneBox').hidden = true;
  const withChallenge = $('chkChallenge').checked;
  try {
    const id = await prepareSession();
    await new Promise(r => requestAnimationFrame(r));     // runs right after draw(): canvas and lastDrawn agree
    const seen = lastDrawn;
    const snap = document.createElement('canvas');
    snap.width = canvas.width; snap.height = canvas.height;
    snap.getContext('2d').drawImage(canvas, 0, 0);
    $('flash').classList.remove('go'); void $('flash').offsetWidth; $('flash').classList.add('go');
    prepared = null;
    const blob = await new Promise(r => snap.toBlob(r, 'image/jpeg', 0.92));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const hash = keccak256(bytes);
    $('sSession').textContent = certNo(id);
    $('feed').innerHTML = '<div class="ln hd"><span>片段</span><span class="sz">大小</span><span class="h">指纹</span><span>区块</span><span class="st">状态</span></div>';
    feedRows.clear(); feedRow(0, bytes.length, hash, seen.number);
    const tx = await sendTx(encodeFunctionData({ abi, functionName: 'anchor', args: [id, 0, hash, 0n, bytes.length, seen.number, seen.hash] }), GAS_ANCHOR);
    setRow(0, 'pend', '确认中');
    const rc = await pub.waitForTransactionReceipt({ hash: tx, pollingInterval: 250 });
    if (rc.status !== 'success') throw new Error('reverted');
    const a = parseEventLogs({ abi, logs: rc.logs, eventName: 'Anchored' })[0].args;
    const win = Number(a.anchorBlock - a.seenBlock) * 0.4;
    setRow(0, 'ok', `✓ ${win.toFixed(1)}s`, `#${a.seenBlock} → #${a.anchorBlock}`);
    $('sOk').textContent = '1 张照片'; $('sWin').textContent = `${win.toFixed(1)}s`;
    await saveVideo(id, blob);
    const list = store.get('nowproof_records', []);
    list.unshift({ id: String(id), scene, challenge: withChallenge, kind: 'photo', at: Date.now(), segs: 1, ok: 1, win: +win.toFixed(1), size: blob.size });
    store.set('nowproof_records', list.slice(0, 100));
    $('doneText').textContent = `${certNo(id)} · 照片已锚定 · 时间窗 ${win.toFixed(1)}s`;
    $('btnViewCert').href = `#/proof/${id}`;
    $('dlLink').href = URL.createObjectURL(blob); $('dlLink').download = `nowproof-${certNo(id)}.jpg`;
    $('doneBox').hidden = false;
    refreshBalance();
  } catch { setRow(0, 'bad', '✗ 未上链'); toast('拍照存证失败，请重试'); }
  shooting = false; $('btnShutter').disabled = false;
  if (mode === 'photo') prepareSession();
}

async function finishRecording() {
  const r = rec;
  const blob = new Blob(r.chunks, { type: r.mime.split(';')[0] });
  $('doneText').textContent = '正在确认最后的片段…';
  $('doneBox').hidden = false;
  $('btnViewCert').href = `#/proof/${r.id}`;
  $('dlLink').href = URL.createObjectURL(blob); $('dlLink').download = `nowproof-${certNo(r.id)}.webm`;
  await saveVideo(r.id, blob);
  while (r.pending.size) await sleep(400);
  const avg = r.ok ? r.lagSum / r.ok * 0.4 : 0;
  const list = store.get('nowproof_records', []);
  list.unshift({ id: String(r.id), scene: r.scene, challenge: r.challenge, at: Date.now(), segs: r.seq, ok: r.ok, win: +avg.toFixed(1), size: blob.size });
  store.set('nowproof_records', list.slice(0, 100));
  $('doneText').textContent = `${certNo(r.id)} · ${r.ok} 个片段已锚定 · 平均时间窗 ${avg.toFixed(1)}s`;
  rec = null;
  $('btnShutter').classList.remove('rec'); $('btnShutter').disabled = false;
  $('liveMeter').hidden = true;
  refreshBalance();
}

// ---------------------------------------------------------------- records view
function renderRecords() {
  const list = store.get('nowproof_records', []);
  const box = $('records');
  if (!list.length) { box.innerHTML = '<div class="empty">暂无存证记录</div>'; return; }
  box.innerHTML = '';
  for (const r of list) {
    const s = SCENES[r.scene] || SCENES.general;
    const a = document.createElement('a');
    a.className = 'rec-item'; a.href = `#/proof/${r.id}`;
    a.innerHTML = `<span class="ic">${s.ic}</span>
      <div><b>${s.name}${r.challenge ? ' · 真人挑战' : ''}</b><small>${new Date(r.at).toLocaleString('zh-CN', { hour12: false })} · ${r.kind === 'photo' ? '照片' : `视频 ${(r.segs * 0.4).toFixed(1)}s · ${r.ok} 段`}</small></div>
      <code>${certNo(r.id)}</code><span class="pill ok">已存证</span>`;
    box.appendChild(a);
  }
}
$('btnFind').onclick = () => { const v = $('findId').value.replace(/\D/g, ''); if (v) location.hash = `#/proof/${Number(v)}`; };
$('findId').onkeydown = e => { if (e.key === 'Enter') $('btnFind').click(); };

// ---------------------------------------------------------------- proof / certificate view
let proof = null;              // { id, owner, startBlock, label, anchors }
let verifyBlob = null, verifyBytes = null, results = [];
const hashCache = new Map();

async function fetchAnchors(id, start) {
  const top = head ? head.number : await pub.getBlockNumber();
  const out = new Map();
  let from = start, lastHit = null;
  while (from <= top) {
    const ranges = [];
    for (let i = 0; i < 5 && from <= top; i++) {
      const to = from + BigInt(LOG_RANGE - 1) > top ? top : from + BigInt(LOG_RANGE - 1);
      ranges.push([from, to]); from = to + 1n;
    }
    const batches = await Promise.all(ranges.map(([f, t]) =>
      pub.getContractEvents({ address: cfg.address, abi, eventName: 'Anchored', args: { id }, fromBlock: f, toBlock: t })));
    for (const l of batches.flat()) {
      const seq = Number(l.args.seq);
      if (!out.has(seq)) out.set(seq, { ...l.args, tx: l.transactionHash });
      lastHit = l.blockNumber;
    }
    if (lastHit !== null && from > lastHit + 300n) break;
    if (lastHit === null && from > start + 1500n) break;
  }
  return out;
}

function setStatus(cls, text) { $('certStatus').innerHTML = `<span class="pill ${cls}">${text}</span>`; }

async function openProof(arg) {
  if (!/^\d+$/.test(arg || '')) { location.hash = '#/records'; return; }
  const id = BigInt(arg);
  proof = null; verifyBlob = null; verifyBytes = null; results = [];
  $('certNo').textContent = certNo(id);
  for (const k of ['cScene', 'cTime', 'cBlocks', 'cSegs', 'cWin', 'cOwner']) $(k).textContent = '—';
  setStatus('', '读取中');
  $('verdict').hidden = true; $('verdict').className = 'verdict'; $('vResult').hidden = true; $('timelineCard').hidden = true;
  $('btnVerify').disabled = true; $('vbHint').textContent = '选择与本证书对应的视频文件';
  try {
    const s = await pub.readContract({ address: cfg.address, abi, functionName: 'sessions', args: [id] });
    if (/^0x0+$/.test(s[0])) { setStatus('bad', '不存在'); return; }
    const [owner, startBlock, startTime] = s;
    const ev = await pub.getContractEvents({ address: cfg.address, abi, eventName: 'SessionStarted', args: { id }, fromBlock: startBlock, toBlock: startBlock });
    let label = {}; try { label = JSON.parse(ev[0]?.args.label || '{}'); } catch {}
    const anchors = await fetchAnchors(id, startBlock);
    if (parseHash().arg !== arg) return;
    proof = { id, owner, startBlock, label, anchors, photo: label.m === 'p' };
    const list = [...anchors.values()];
    const lags = list.map(a => Number(a.anchorBlock - a.seenBlock));
    const localRec = store.get('nowproof_records', []).find(r => r.id === arg);
    const sc = SCENES[localRec?.scene || label.s];
    $('cScene').textContent = sc ? `${sc.ic} ${sc.name}${label.c ? ' · 真人挑战' : ''}` : `🔒 私密${label.c ? ' · 真人挑战' : ''}`;
    $('cTime').textContent = new Date(Number(startTime) * 1000).toLocaleString('zh-CN', { hour12: false });
    if (list.length) {
      const minB = list.reduce((m, a) => a.seenBlock < m ? a.seenBlock : m, list[0].seenBlock);
      const maxB = list.reduce((m, a) => a.anchorBlock > m ? a.anchorBlock : m, list[0].anchorBlock);
      $('cBlocks').textContent = `#${minB} – #${maxB}`;
      $('cWin').textContent = `${(lags.reduce((a, c) => a + c, 0) / lags.length * 0.4).toFixed(1)}s`;
    }
    $('cSegs').textContent = proof.photo ? (list.length ? '1 张照片' : '未锚定') : `${list.length} 段 · ${(list.length * 0.4).toFixed(1)}s`;
    $('cSegs').previousElementSibling.textContent = proof.photo ? '内容' : '片段数';
    $('cOwner').textContent = short(owner, 8, 6);
    setStatus('', '已上链 · 待核验');
    const local = await loadVideo(arg);
    if (local && parseHash().arg === arg) {
      verifyBlob = local; $('vbHint').textContent = '已载入本机原件'; $('btnVerify').disabled = false;
      runVerify();
    }
  } catch (e) { setStatus('bad', '读取失败'); }
}

$('vFile').onchange = () => {
  const f = $('vFile').files[0]; if (!f) return;
  verifyBlob = f; $('vbHint').textContent = f.name; $('btnVerify').disabled = !proof;
};
$('btnVerify').onclick = () => runVerify();
$('btnShare').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); toast('证书链接已复制'); } catch { toast(location.href, 6000); }
};

function checkSegments(bytes, anchors) {
  const maxSeq = Math.max(-1, ...anchors.keys());
  const res = [];
  for (let seq = 0; seq <= maxSeq; seq++) {
    const a = anchors.get(seq);
    if (!a) { res.push({ seq, status: 'miss' }); continue; }
    const off = Number(a.offset), size = Number(a.size);
    const slice = bytes.subarray(off, off + size);
    const ok = slice.length === size && keccak256(slice) === a.chunkHash;
    res.push({ seq, status: ok ? 'ok' : 'bad', a, lag: Number(a.anchorBlock - a.seenBlock) });
  }
  return res;
}

async function runVerify(tampered = false) {
  if (!proof || !verifyBlob) return;
  $('btnVerify').disabled = true;
  try {
    if (!tampered) verifyBytes = new Uint8Array(await verifyBlob.arrayBuffer());
    results = checkSegments(verifyBytes, proof.anchors);
    renderVerdict();
    renderTimeline();
    const isImg = proof.photo || (verifyBlob.type || '').startsWith('image/');
    $('vPlayer').hidden = isImg; $('vImage').hidden = !isImg;
    const url = URL.createObjectURL(new Blob([verifyBytes], { type: isImg ? 'image/jpeg' : 'video/webm' }));
    if (isImg) { $('vPlayer').removeAttribute('src'); $('vImage').src = url; } else $('vPlayer').src = url;
    $('vResult').hidden = false; $('timelineCard').hidden = false;
  } catch { toast('核验失败，请确认文件'); }
  $('btnVerify').disabled = false;
}

function renderVerdict() {
  const ok = results.filter(r => r.status === 'ok').length, bad = results.filter(r => r.status === 'bad');
  const v = $('verdict'); v.hidden = false;
  if (!results.length) { v.className = 'verdict bad'; v.innerHTML = '<b>无锚定记录</b>'; setStatus('bad', '无记录'); return; }
  if (!bad.length && ok) {
    v.className = 'verdict ok';
    v.innerHTML = proof.photo ? '<b>✓ 核验通过</b><p>照片与链上指纹完全一致，自拍摄以来未被修改。</p>'
      : `<b>✓ 核验通过</b><p>${ok} 个片段与链上指纹完全一致，视频自录制以来未被修改。</p>`;
    setStatus('ok', '✓ 核验通过');
  } else {
    const secs = bad.map(r => fmtSec(r.seq * 0.4)).slice(0, 5).join('、');
    v.className = 'verdict bad';
    v.innerHTML = proof.photo ? '<b>⚠ 照片已被修改</b><p>照片指纹与链上记录不符，文件在存证之后被修改过。</p>'
      : `<b>⚠ 视频已被篡改</b><p>${bad.length} 个片段与链上指纹不符，位置：${secs}${bad.length > 5 ? ' 等' : ''}。其余 ${ok} 个片段一致。</p>`;
    setStatus('bad', '⚠ 发现篡改');
  }
}
const fmtSec = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;

function renderTimeline() {
  const tl = $('timeline'); tl.innerHTML = '';
  for (const r of results) {
    const c = document.createElement('div');
    c.className = `c ${r.status === 'miss' ? '' : r.status}`;
    c.title = fmtSec(r.seq * 0.4);
    c.onclick = () => { showSeg(r.seq); try { $('vPlayer').currentTime = r.seq * 0.4; } catch {} };
    tl.appendChild(c);
  }
  showSeg(0);
}

async function blockHashOf(n) {
  if (hashCache.has(n)) return hashCache.get(n);
  const p = pub.getBlock({ blockNumber: n }).then(b => b.hash).catch(() => null);
  hashCache.set(n, p);
  return p;
}

async function showSeg(seq) {
  const r = results[Math.max(0, Math.min(seq, results.length - 1))]; if (!r) return;
  document.querySelectorAll('.timeline .c').forEach((c, i) => c.classList.toggle('cur', i === r.seq));
  const tag = { ok: '<span class="pill ok">指纹一致</span>', bad: '<span class="pill bad">已被篡改</span>', miss: '<span class="pill">缺失</span>' }[r.status];
  const pos = proof.photo ? '照片' : fmtSec(r.seq * 0.4);
  if (!r.a) { $('segInfo').innerHTML = `${tag}<div class="kv"><span>位置</span><code>${pos}</code></div>`; return; }
  const a = r.a;
  $('segInfo').innerHTML = `${tag}
    <div class="big">${(r.lag * 0.4).toFixed(1)}s <small>时间窗</small></div>
    <div class="kv"><span>位置</span><code>${pos}</code></div>
    <div class="kv"><span>画面区块</span><code>#${a.seenBlock}</code></div>
    <div class="kv"><span>区块哈希</span><code>${a.seenHash.slice(0, 14)}…</code></div>
    <div class="kv"><span>锚定区块</span><code>#${a.anchorBlock}</code></div>
    <div class="kv"><span>交易</span><a href="${EXPLORER}/tx/${a.tx}" target="_blank" rel="noopener">${short(a.tx)}</a></div>
    <div id="chBox"></div>`;
  if (proof.label.c) {
    const bn = (a.seenBlock / CH_BUCKET) * CH_BUCKET;
    const h = await blockHashOf(bn);
    if (h && $('chBox')) { const c = challengeOf(h); $('chBox').innerHTML = `<div class="challenge">挑战指令 <b>${c.action} · ${c.code}</b><br><small class="muted">区块 #${bn}</small></div>`; }
  }
}
$('vPlayer').ontimeupdate = () => showSeg(Math.floor($('vPlayer').currentTime / 0.4));

async function tamperPhoto() {
  // Simulate a retouch: clone a patch of the photo over another area, then re-encode.
  const img = await createImageBitmap(new Blob([verifyBytes], { type: 'image/jpeg' }));
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const w = Math.round(img.width * 0.22), h = Math.round(img.height * 0.22);
  g.drawImage(c, img.width * 0.12, img.height * 0.2, w, h, img.width * 0.55, img.height * 0.3, w, h);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  verifyBytes = new Uint8Array(await blob.arrayBuffer());
  runVerify(true);
}

$('btnTamper').onclick = () => {
  if (proof?.photo) return tamperPhoto();
  const candidates = results.filter(r => r.status === 'ok' && r.seq > 0);
  if (!candidates.length) return;
  const r = candidates[Math.floor(candidates.length * (0.3 + Math.random() * 0.4))] || candidates[0];
  verifyBytes = verifyBytes.slice();
  const off = Number(r.a.offset), size = Number(r.a.size);
  const from = off + Math.max(0, Math.floor(size / 2) - 256);
  for (let i = 0; i < Math.min(512, size); i++) verifyBytes[from + i] ^= 0x5a;
  runVerify(true);
};

// ---------------------------------------------------------------- boot
connectHeads();
refreshBalance();
route();
