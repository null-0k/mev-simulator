## MEV Redistribution Pool (Stake-Proportional)

Ethereum における Miner / Maximal Extractable Value (MEV) を可視化し、さまざまな戦略やネットワーク条件下でのインパクトを評価する オープンソース・シミュレーター です。Solidity 製スマートコントラクトと JavaScript / Python 製ツールチェーンを組み合わせ、ローカル環境で高速にシナリオを実行できます。

📢 目的 — 本プロジェクトは研究・教育用途を想定しています。メインネットでの実運用やエコシステムへ悪影響を与える行為は推奨しません。

## デプロイ & テスト手順

### 1. 環境準備

```bash
git clone https://github.com/your-org/mev-redistribution-pool.git
cd mev-redistribution-pool
pnpm install
```

### 2. コンパイル
```bash
npx hardhat compile
```

### 3.ローカルネットでテスト
```bash
npx hardhat test
```
