// Compile contracts/NowProof.sol with solc-js and deploy to Monad testnet.
// Writes web/contract.json (address + abi) for the frontend.
import fs from 'node:fs';
import solc from 'solc';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

const src = fs.readFileSync('contracts/NowProof.sol', 'utf8');
const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: { 'NowProof.sol': { content: src } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
const errs = (out.errors || []).filter(e => e.severity === 'error');
if (errs.length) { console.error(errs.map(e => e.formattedMessage).join('\n')); process.exit(1); }
const c = out.contracts['NowProof.sol'].NowProof;

const pk = fs.readFileSync('.deployer.env', 'utf8').match(/PRIVATE_KEY=(0x[0-9a-fA-F]+)/)[1];
const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: monadTestnet, transport: http() });
const wallet = createWalletClient({ account, chain: monadTestnet, transport: http() });

console.log('deployer', account.address, 'balance', Number(await pub.getBalance({ address: account.address })) / 1e18);
const hash = await wallet.deployContract({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object });
const rc = await pub.waitForTransactionReceipt({ hash });
console.log('deployed', rc.contractAddress, 'block', rc.blockNumber);
fs.writeFileSync('web/contract.json', JSON.stringify({
  chainId: monadTestnet.id, address: rc.contractAddress, deployBlock: Number(rc.blockNumber), abi: c.abi,
}, null, 2));
