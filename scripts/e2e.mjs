// End-to-end check against the deployed contract:
// start a session, fire N anchors back-to-back (like the browser does every 0.4s),
// then read the events back and verify the time-sandwich window for each segment.
import fs from 'node:fs';
import { createPublicClient, createWalletClient, http, keccak256, toHex, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

const N = Number(process.argv[2] || 10);
const { address, abi } = JSON.parse(fs.readFileSync('web/contract.json', 'utf8'));
const pk = fs.readFileSync('.deployer.env', 'utf8').match(/PRIVATE_KEY=(0x[0-9a-fA-F]+)/)[1];
const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: monadTestnet, transport: http() });
const wallet = createWalletClient({ account, chain: monadTestnet, transport: http() });

const h = await wallet.writeContract({ address, abi, functionName: 'start', args: ['e2e'] });
const rc = await pub.waitForTransactionReceipt({ hash: h });
const id = parseEventLogs({ abi, logs: rc.logs, eventName: 'SessionStarted' })[0].args.id;
console.log('session', id);

let nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
const hashes = [];
for (let seq = 0; seq < N; seq++) {
  const blk = await pub.getBlock({ blockTag: 'latest' });
  const chunk = toHex(`chunk-${seq}-${Date.now()}`);
  const tx = await wallet.writeContract({
    address, abi, functionName: 'anchor', nonce: nonce++, gas: 50000n,
    args: [id, seq, keccak256(chunk), BigInt(seq * 1234), 1234, blk.number, blk.hash],
  });
  hashes.push(tx);
  await new Promise(r => setTimeout(r, 400));
}
let ok = 0;
for (const tx of hashes) {
  const r = await pub.waitForTransactionReceipt({ hash: tx });
  if (r.status !== 'success') { console.log('REVERT', tx); continue; }
  const ev = parseEventLogs({ abi, logs: r.logs, eventName: 'Anchored' })[0].args;
  const lag = Number(ev.anchorBlock - ev.seenBlock);
  console.log(`seq ${ev.seq}: seen #${ev.seenBlock} -> anchored #${ev.anchorBlock}  lag ${lag} blocks (~${(lag * 0.4).toFixed(1)}s)  gasUsed ${r.gasUsed}`);
  ok++;
}
console.log(`${ok}/${N} anchored`);
process.exit(ok === N ? 0 : 1);
