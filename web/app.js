import {
  createPublicClient, http, keccak256, parseEventLogs, formatEther, encodeFunctionData,
  privateKeyToAccount, generatePrivateKey, monadTestnet,
} from './vendor.js';

const RPC = 'https://testnet-rpc.monad.xyz';
const FAUCET = 'https://agents.devnads.com/v1/faucet';
const EXPLORER = 'https://testnet.monadexplorer.com';
const SLICE_MS = 400;          // one video segment per Monad block time
const GAS_START = 150000n;
const GAS_ANCHOR = 45000n;     // measured ~35.2k; Monad bills the gas limit, keep it tight
const LOG_RANGE = 100;         // testnet RPC caps eth_getLogs at 100 blocks

const cfg = await fetch('./contract.json').then(r => r.json());
const abi = cfg.abi;
const pub = createPublicClient({ chain: monadTestnet, transport: http(RPC, { batch: false }) });

const $ = id => document.getElementById(id);
const short = (h, a = 6, b = 4) => h ? `${h.slice(0, a)}…${h.slice(-b)}` : '—';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function toast(msg, ms = 3500) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
$('contractLink').textContent = short(cfg.address, 8, 6);
$('contractLink').href = `${EXPLORER}/address/${cfg.address}`;

// ---------------------------------------------------------------- tabs
function showTab(name) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
}
document.querySelectorAll('.tab').forEach(b => b.onclick = () => showTab(b.dataset.tab));

// ---------------------------------------------------------------- live chain head
let head = null;               // { number: bigint, hash, at: ms }
const blockTimes = [];
async function pollHead() {
  try {
    const b = await pub.getBlock({ blockTag: 'latest' });
    if (!head || b.number > head.number) {
      const now = performance.now();
      if (head) {
        const per = (now - head.at) / Number(b.number - head.number);
        blockTimes.push(per); if (blockTimes.length > 30) blockTimes.shift();
      }
      head = { number: b.number, hash: b.hash, at: now };
      $('headBlock').textContent = `#${b.number}`;
      document.querySelector('.dot').classList.add('live');
      if (blockTimes.length > 4) {
        const avg = blockTimes.reduce((a, c) => a + c, 0) / blockTimes.length / 1000;
        $('blockTime').textContent = `${avg.toFixed(2)} s/块`;
      }
    }
  } catch { document.querySelector('.dot').classList.remove('live'); }
  setTimeout(pollHead, 200);
}
pollHead();

// ---------------------------------------------------------------- burner wallet
function loadKey() {
  let k = null;
  try { k = localStorage.getItem('nowproof_key'); } catch {}
  if (!k) { k = generatePrivateKey(); try { localStorage.setItem('nowproof_key', k); } catch {} }
  return k;
}
const account = privateKeyToAccount(loadKey());
$('wAddr').textContent = short(account.address, 8, 6);
$('wAddr').title = account.address;
let balance = 0n;
async function refreshBalance() {
  try { balance = await pub.getBalance({ address: account.address }); $('wBal').textContent = `${Number(formatEther(balance)).toFixed(4)} MON`; } catch {}
  return balance;
}
refreshBalance();

async function fund() {
  $('btnFund').disabled = true;
  toast('正在从 Monad 测试网水龙头领取 MON…');
  try {
    const r = await fetch(FAUCET, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chainId: 10143, address: account.address }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.txHash) throw new Error(j.error || j.message || `HTTP ${r.status}`);
    const before = balance;
    for (let i = 0; i < 20 && (await refreshBalance()) <= before; i++) await sleep(500);
    toast('已到账 ✔');
  } catch (e) { toast(`领取失败：${e.message}`); }
  $('btnFund').disabled = false;
}
$('btnFund').onclick = fund;

// ---------------------------------------------------------------- tx helpers
let nonce = null, gasPrice = null;
async function sendTx(data, gas) {
  if (gasPrice === null) gasPrice = await pub.getGasPrice();
  if (nonce === null) nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
  const n = nonce++;
  const raw = await account.signTransaction({ type: 'legacy', chainId: monadTestnet.id, to: cfg.address, data, gas, gasPrice, nonce: n });
  try {
    return await pub.request({ method: 'eth_sendRawTransaction', params: [raw] });
  } catch (e) { nonce = null; throw e; }
}

// ---------------------------------------------------------------- camera + overlay
const canvas = $('cam'), ctx = canvas.getContext('2d');
const video = document.createElement('video');
video.muted = true; video.playsInline = true;
let source = null;             // 'camera' | 'demo'
let rec = null;                // active recording state
let drawnMin = null;           // earliest block burned into frames of the current segment

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream; await video.play();
    source = 'camera';
  } catch (e) {
    toast('无法打开摄像头，已切换为演示画面');
    source = 'demo';
  }
  const w = source === 'camera' ? video.videoWidth : 1280, h = source === 'camera' ? video.videoHeight : 720;
  const scale = Math.min(1, 1280 / w);
  canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
  $('camEmpty').hidden = true;
  $('btnStart').disabled = false;
  requestAnimationFrame(draw);
}
$('btnCam').onclick = startCamera;

function drawDemo(t) {
  const W = canvas.width, H = canvas.height;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1a1530'); g.addColorStop(1, '#0d2230');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 6; i++) {
    const x = W / 2 + Math.cos(t / 900 + i) * W * 0.3, y = H * 0.42 + Math.sin(t / 700 + i * 2) * H * 0.22;
    ctx.beginPath(); ctx.arc(x, y, 40 + 18 * Math.sin(t / 400 + i), 0, 7);
    ctx.fillStyle = `hsla(${(i * 55 + t / 30) % 360},80%,60%,.55)`; ctx.fill();
  }
  ctx.fillStyle = '#fff'; ctx.font = `600 ${Math.round(H / 14)}px system-ui`; ctx.textAlign = 'center';
  ctx.fillText(new Date().toLocaleTimeString('zh-CN', { hour12: false }), W / 2, H * 0.45);
  ctx.textAlign = 'left';
}

function draw(t) {
  const W = canvas.width, H = canvas.height;
  if (source === 'camera') ctx.drawImage(video, 0, 0, W, H); else drawDemo(t);
  const band = Math.round(H * 0.16);
  ctx.fillStyle = 'rgba(8,8,14,.78)'; ctx.fillRect(0, H - band, W, band);
  ctx.fillStyle = '#836ef9'; ctx.fillRect(0, H - band, 6, band);
  const pad = Math.round(H * 0.03);
  if (head) {
    if (rec && (!drawnMin || head.number < drawnMin.number)) drawnMin = { number: head.number, hash: head.hash };
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
  ctx.fillText(rec ? `NowProof · 会话 #${rec.id ?? '…'} · 片段 #${rec.seq}` : 'NowProof · 此刻为证', W - pad, H - band + band * 0.8);
  ctx.textAlign = 'left';
  if (rec) $('recTime').textContent = `${((performance.now() - rec.t0) / 1000).toFixed(1)}s`;
  requestAnimationFrame(draw);
}

// ---------------------------------------------------------------- recording
const feedRows = new Map();
function feedHeader() {
  $('feed').innerHTML = '<div class="ln hd"><span>片段</span><span>大小</span><span class="h">视频指纹 keccak256</span><span>区块夹心</span><span class="st">状态</span></div>';
}
function feedRow(seq, size, hash, seen) {
  const el = document.createElement('div');
  el.className = 'ln new';
  el.innerHTML = `<span>#${seq}</span><span>${(size / 1024).toFixed(1)} KB</span><span class="h">${short(hash, 14, 8)}</span><span class="tx">#${seen} → …</span><span class="st pend">发送中</span>`;
  $('feed').appendChild(el); $('feed').scrollTop = 1e9;
  feedRows.set(seq, el);
  return el;
}
function setRow(seq, cls, text, sandwich) {
  const el = feedRows.get(seq); if (!el) return;
  const st = el.querySelector('.st'); st.className = `st ${cls}`; st.textContent = text;
  if (sandwich) el.querySelector('.tx').textContent = sandwich;
}

function updateStats() {
  $('sSent').textContent = rec.sent;
  $('sOk').textContent = rec.ok;
  if (rec.ok) $('sWin').textContent = `${(rec.lagSum / rec.ok * 0.4).toFixed(1)}s`;
}

async function startRecording() {
  $('btnStart').disabled = true;
  if (!head) return toast('还没连上 Monad，请稍候');
  if ((await refreshBalance()) < 50000000000000000n) await fund();
  if (balance < 20000000000000000n) { $('btnStart').disabled = false; return toast('余额不足，请先领取测试 MON'); }

  rec = { id: null, seq: 0, offset: 0, chunks: [], sent: 0, ok: 0, lagSum: 0, pending: new Map(), t0: performance.now(), chain: Promise.resolve(), stopped: false };
  feedHeader(); feedRows.clear();
  $('doneBox').hidden = true; $('sSession').textContent = '…';
  toast('正在链上创建存证会话…');
  try {
    const hash = await sendTx(encodeFunctionData({ abi, functionName: 'start', args: [$('label').value || 'NowProof'] }), GAS_START);
    const rc = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 });
    rec.id = parseEventLogs({ abi, logs: rc.logs, eventName: 'SessionStarted' })[0].args.id;
    rec.scanFrom = rc.blockNumber;
  } catch (e) { rec = null; $('btnStart').disabled = false; return toast(`创建会话失败：${e.shortMessage || e.message}`); }
  $('sSession').textContent = rec.id;

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
  $('recBadge').hidden = false;
  $('btnStop').disabled = false;
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
    rec.sent++; updateStats();
    setRow(seq, 'pend', '确认中');
  } catch (e) {
    setRow(seq, 'bad', '发送失败');
  }
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
        setRow(seq, 'ok', `✔ ${(lag * 0.4).toFixed(1)}s 窗`, `#${a.seenBlock} → #${a.anchorBlock}`);
      }
      r.scanFrom = to + 1n;
      for (const [seq, p] of r.pending) {
        if (head.number > p.sentAt + 25n) {
          r.pending.delete(seq);
          const rc = await pub.getTransactionReceipt({ hash: p.tx }).catch(() => null);
          setRow(seq, 'bad', rc && rc.status === 'reverted' ? '✘ 超出时间窗' : '✘ 未上链');
        }
      }
      updateStats();
    } catch {}
  }
}

function stopRecording() {
  $('btnStop').disabled = true;
  if (!rec || !rec.mr) return;
  rec.stopped = true;
  rec.mr.stop();
  $('recBadge').hidden = true;
}

let lastRecording = null;
async function finishRecording() {
  const r = rec;
  const blob = new Blob(r.chunks, { type: r.mime.split(';')[0] });
  lastRecording = { id: r.id, blob };
  const url = URL.createObjectURL(blob);
  $('dlLink').href = url; $('dlLink').download = `nowproof-s${r.id}.webm`;
  $('doneBox').hidden = false;
  $('btnStart').disabled = false;
  toast('录制完成，等待最后几个片段上链…');
  while (r.pending.size) await sleep(500);
  rec = null;
  refreshBalance();
  toast(`完成：${r.ok}/${r.sent} 个片段已上链`);
}
$('btnStart').onclick = startRecording;
$('btnStop').onclick = stopRecording;
$('btnVerifyNow').onclick = () => {
  if (!lastRecording) return;
  showTab('verify');
  $('vSession').value = lastRecording.id;
  verifyBlob = lastRecording.blob;
  runVerify();
};

// ---------------------------------------------------------------- verification
let verifyBlob = null, verifyBytes = null, anchorsCache = null, results = [];
$('vFile').onchange = () => {
  const f = $('vFile').files[0]; if (!f) return;
  verifyBlob = f;
  const m = f.name.match(/nowproof-s(\d+)/);
  if (m) $('vSession').value = m[1];
};
$('btnVerify').onclick = () => runVerify();

async function fetchAnchors(id) {
  const s = await pub.readContract({ address: cfg.address, abi, functionName: 'sessions', args: [id] });
  if (/^0x0+$/.test(s[0])) throw new Error(`会话 #${id} 不存在`);
  const start = s[1];
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
  return { owner: s[0], startBlock: start, anchors: out };
}

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
  const id = $('vSession').value.trim();
  if (!/^\d+$/.test(id)) return toast('请输入会话 ID');
  if (!verifyBlob) return toast('请选择视频文件');
  $('btnVerify').disabled = true;
  $('verdict').hidden = false; $('verdict').className = 'verdict'; $('verdict').innerHTML = '正在从 Monad 读取链上证据并逐段比对…';
  try {
    if (!tampered) {
      verifyBytes = new Uint8Array(await verifyBlob.arrayBuffer());
      anchorsCache = await fetchAnchors(BigInt(id));
    }
    results = checkSegments(verifyBytes, anchorsCache.anchors);
    renderVerdict(id, tampered);
    renderTimeline();
    $('vPlayer').src = URL.createObjectURL(new Blob([verifyBytes], { type: 'video/webm' }));
    $('vResult').hidden = false; $('timelineCard').hidden = false;
    $('btnTamper').disabled = false;
  } catch (e) {
    $('verdict').className = 'verdict bad';
    $('verdict').innerHTML = `<b>无法验证</b>${e.shortMessage || e.message}`;
  }
  $('btnVerify').disabled = false;
}

function renderVerdict(id, tampered) {
  const ok = results.filter(r => r.status === 'ok'), bad = results.filter(r => r.status === 'bad'), miss = results.filter(r => r.status === 'miss');
  const lags = ok.map(r => r.lag);
  const avg = lags.length ? lags.reduce((a, c) => a + c, 0) / lags.length * 0.4 : 0;
  const max = lags.length ? Math.max(...lags) * 0.4 : 0;
  const first = ok[0]?.a, last = ok[ok.length - 1]?.a;
  const v = $('verdict');
  if (!results.length) { v.className = 'verdict bad'; v.innerHTML = `<b>链上没有该会话的存证记录</b>`; return; }
  if (bad.length === 0 && ok.length) {
    v.className = 'verdict ok';
    v.innerHTML = `<b>✅ 真实可信：${ok.length}/${results.length} 个片段与 Monad 链上指纹完全一致</b>
      每一段画面都诞生于平均 <code>${avg.toFixed(1)}s</code>（最长 <code>${max.toFixed(1)}s</code>）的区块夹心时间窗内，无法事后伪造或剪辑。
      <div class="facts"><span>会话 <code>#${id}</code></span><span>区块 <code>#${first.seenBlock}</code> → <code>#${last.anchorBlock}</code></span>
      <span>时长 ≈ <code>${(results.length * 0.4).toFixed(1)}s</code></span><span>录制者 <code>${short(anchorsCache.owner)}</code></span>${miss.length ? `<span>${miss.length} 段未上链</span>` : ''}</div>`;
  } else {
    const secs = bad.map(r => `${(r.seq * 0.4).toFixed(1)}s`).slice(0, 6).join('、');
    v.className = 'verdict bad';
    v.innerHTML = `<b>⚠️ 检测到篡改：${bad.length} 个片段与链上指纹不符</b>
      被改动的位置：约第 ${secs}${bad.length > 6 ? ' 等' : ''}。其余 ${ok.length} 段仍然可信。${tampered ? '（这是「模拟篡改」的结果）' : ''}
      <div class="facts"><span>会话 <code>#${id}</code></span><span>可信片段 <code>${ok.length}</code></span><span>篡改片段 <code>${bad.length}</code></span></div>`;
  }
}

function renderTimeline() {
  const tl = $('timeline'); tl.innerHTML = '';
  for (const r of results) {
    const c = document.createElement('div');
    c.className = `c ${r.status === 'miss' ? '' : r.status}`;
    c.title = `片段 #${r.seq} · ${(r.seq * 0.4).toFixed(1)}s`;
    c.onclick = () => { showSeg(r.seq); const p = $('vPlayer'); try { p.currentTime = r.seq * 0.4; } catch {} };
    tl.appendChild(c);
  }
  showSeg(0);
}

function showSeg(seq) {
  const r = results[Math.max(0, Math.min(seq, results.length - 1))]; if (!r) return;
  document.querySelectorAll('.timeline .c').forEach((c, i) => c.classList.toggle('cur', i === r.seq));
  const tag = { ok: '<span class="tag ok">指纹一致</span>', bad: '<span class="tag bad">已被篡改</span>', miss: '<span class="tag miss">链上无记录</span>' }[r.status];
  if (!r.a) { $('segInfo').innerHTML = `${tag}<div>片段 #${r.seq}</div>`; return; }
  const a = r.a;
  $('segInfo').className = 'seginfo';
  $('segInfo').innerHTML = `${tag}
    <div class="kv"><span>片段</span><code>#${r.seq} · ${(r.seq * 0.4).toFixed(1)}s</code></div>
    <div class="kv"><span>画面应显示</span><code>#${a.seenBlock}</code></div>
    <div class="kv"><span>区块哈希</span><code>${a.seenHash.slice(0, 18)}</code></div>
    <div class="kv"><span>指纹写入区块</span><code>#${a.anchorBlock}</code></div>
    <div class="big">${(r.lag * 0.4).toFixed(1)}s <small class="muted" style="font-size:12px">时间窗</small></div>
    <div class="kv"><span>上链交易</span><a href="${EXPLORER}/tx/${a.tx}" target="_blank" rel="noopener">${short(a.tx)}</a></div>
    <p class="muted small">对照视频画面底部：区块号与哈希应与上面一致。</p>`;
}
$('vPlayer').ontimeupdate = () => showSeg(Math.floor($('vPlayer').currentTime / 0.4));

$('btnTamper').onclick = () => {
  const candidates = results.filter(r => r.status === 'ok' && r.seq > 0);
  if (!candidates.length) return toast('没有可篡改的片段');
  const r = candidates[Math.floor(candidates.length / 2 + (Math.random() - 0.5) * candidates.length * 0.5)] || candidates[0];
  verifyBytes = verifyBytes.slice();
  const off = Number(r.a.offset), size = Number(r.a.size);
  const from = off + Math.max(0, Math.floor(size / 2) - 256);
  for (let i = 0; i < Math.min(512, size); i++) verifyBytes[from + i] ^= 0x5a;
  runVerify(true);
};
