# NowProof 此刻为证

> 用 Monad 区块把每 0.4 秒视频「夹」进一个约 2–3 秒的时间窗口，对抗 AI 伪造与事后剪辑。
> Time-sandwich proofs for live video, only practical on a 400ms-block chain.

**在线演示 / Live demo:** https://codeking-ai.github.io/nowproof/
**合约 / Contract (Monad Testnet):** [`0x428e5a1dbd23198f9f554e005e7489b02dca0bd7`](https://testnet.monadexplorer.com/address/0x428e5a1dbd23198f9f554e005e7489b02dca0bd7)

Built at Monad Blitz Shanghai V3 (2026-10-17).

## 问题

AI 生成的视频已经真假难辨：行车记录、事故现场、快递签收、验货视频都可能是伪造的。
现有的「视频指纹上链」只能证明视频**不晚于**某时刻存在。造假者完全可以先花一小时用 AI 生成假视频，再把指纹存上去。

## 机制：时间夹心

| | 怎么做 | 证明了什么 |
|---|---|---|
| 下限 | 录制时，把 Monad 最新区块号和哈希实时烧录进画面 | 区块哈希无法预测，所以画面**不早于**区块 N |
| 上限 | 每 0.4 秒把这段视频的 keccak256 指纹写进链上 | 片段**不晚于**区块 N+k |
| 合约强制 | `blockhash(N)` 校验画面中的哈希是真的，并要求 `k ≤ 10` | 每段视频都被锁在 N…N+k 之间 |

时间窗 ≈ 出块时间 × k。以太坊（12 秒一块）上是 24 秒以上，足够做一个深度伪造；
在 Monad 上，测试网实测平均约 **2–3 秒**。每台设备每秒约 2.5 笔交易，也只有又快又便宜的链扛得住。
**链越快，证明越强。**

## 产品功能

- **首页**：实时区块流、累计存证数、四类场景入口（车险理赔 / 签收打卡 / 二手交易 / 远程面签）
- **拍摄存证**：相机式界面，支持视频和照片两种模式，打开即用，存证账户自动开通。视频每 0.4 秒一段，照片每张一笔，签名后直接上链
- **照片存证（链上水印相机）**：拍照时画面烧录当前区块，水印里带证书编号，照片指纹随即锚定。核验时可识别任何修图
- **真人挑战**：画面每 3 秒（8 个区块）出现一条由区块哈希派生的动作指令和 4 位数字，指令无法预知，核验时可以复算
- **我的存证**：本机存证记录，原始视频保存在 IndexedDB
- **存证证书**：每次存证生成一个可分享的证书链接 `#/proof/<id>`，自动逐段核验，篡改位置精确到 0.4 秒

## 架构

```
contracts/NowProof.sol   会话 + anchor()：校验 blockhash 和时间窗，发出 Anchored 事件
web/                     静态前端（原生 JS + 本地打包的 viem），部署在 GitHub Pages
scripts/deploy.mjs       用 solc-js 编译并部署，生成 web/contract.json
scripts/e2e.mjs          链上测试：连续 anchor N 个片段，检查时间窗
scripts/browser-test.mjs 无头浏览器 + 虚拟摄像头跑完整流程：录制 → 验证 → 篡改
```

所有数据都在链上，没有后端数据库。片段字节偏移量也上链，所以即使中间有一段没上链，其余片段也能独立验证。

## 本地运行

```bash
npm install
echo PRIVATE_KEY=0x... > .deployer.env   # 测试网部署私钥
npm run deploy                           # 编译 + 部署，写入 web/contract.json
npm run test:chain                       # 链上 anchor 测试
cd web && python -m http.server 5173     # 访问 http://localhost:5173
npm run test:browser                     # 完整浏览器流程测试
```

## 局限

如果摄像头硬件本身被攻破，任何软件方案都兜不住。
NowProof 证明的是「这段画面诞生于这个不到几秒的窗口内」，大幅抬高了事后伪造和剪辑的门槛。
下一步计划：自动识别画面中的区块号（OCR / 二维码）、可信硬件签名、批量 Merkle 存证以降低成本。

## 商业模式

按存证时长计费的 API / SDK；面向保险理赔、物流签收、二手交易平台的企业接入；司法存证机构的批量验证服务。

MIT License
