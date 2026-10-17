// Top up a device's NowProof account from the local testnet sponsor wallet (.sponsor.env, git-ignored).
// Usage: node scripts/fund.mjs <address> [amountMON=0.5]
import fs from 'node:fs';
import { createPublicClient, createWalletClient, http, parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

const [to, amount = '0.5'] = process.argv.slice(2);
if (!/^0x[0-9a-fA-F]{40}$/.test(to || '')) { console.error('usage: node scripts/fund.mjs <address> [amount]'); process.exit(1); }
const pk = fs.readFileSync('.sponsor.env', 'utf8').match(/PRIVATE_KEY=(0x[0-9a-fA-F]+)/)[1];
const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: monadTestnet, transport: http() });
const wallet = createWalletClient({ account, chain: monadTestnet, transport: http() });
const hash = await wallet.sendTransaction({ to, value: parseEther(amount) });
await pub.waitForTransactionReceipt({ hash });
console.log(`sent ${amount} MON -> ${to}`);
console.log('device balance', formatEther(await pub.getBalance({ address: to })), '| sponsor left', formatEther(await pub.getBalance({ address: account.address })));
