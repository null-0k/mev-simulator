
# -*- coding: utf-8 -*-
"""
MEV再分配シミュレータ（簡易版）

シナリオ

Baseline       : 閾値を設けず、プロポーザがMEVを全取り
StakePool      : 閾値超過分をプールに入れ、ステーク比で分配
EqualPool      : 超過分をプールに入れ、人数で等分
RootStakePool  : 超過分をプールに入れ、√stake比で分配

出力

Profit Distribution Summary  : 各シナリオの平均利益、標準偏差、ジニ係数
Top 5 Validators Earnings    : ベースライン上位5名の収益をシナリオ横並び比較
"""

import numpy as np
import pandas as pd

# ヘルパ関数 
def gini(arr):
    """配列のジニ係数を計算"""
    arr = np.array(arr, dtype=float)
    if np.amin(arr) < 0:
        arr -= np.amin(arr)        # 非負化
    arr += 1e-9                    # ゼロ除算回避
    arr_sorted = np.sort(arr)      # 昇順ソート
    n = arr.shape[0]
    cum = np.cumsum(arr_sorted)    # 累積和
    return (n + 1 - 2 * np.sum(cum) / cum[-1]) / n

# パラメータ 
NUM_VALIDATORS   = 100            # バリデータ数
NUM_BLOCKS       = 2000           # ブロック数
EPOCH_SIZE       = 100            # プール分配周期（ブロック）
MEV_DIST_MEAN    = 1.0            # 対数正規分布 
MEV_DIST_SIGMA   = 1.0            # 対数正規分布 
RNG              = np.random.default_rng(42)

# ステークを1–99の整数で乱数生成
stakes       = RNG.integers(1, 100, size=NUM_VALIDATORS)
total_stake  = stakes.sum()

# MEVシーケンス生成 
mev_values = RNG.lognormal(MEV_DIST_MEAN, MEV_DIST_SIGMA, size=NUM_BLOCKS)
threshold  = np.median(mev_values)      # 閾値として中央値を採用

# 配当を格納する配列 
earnings = {
    'Baseline'      : np.zeros(NUM_VALIDATORS),
    'StakePool'     : np.zeros(NUM_VALIDATORS),
    'EqualPool'     : np.zeros(NUM_VALIDATORS),
    'RootStakePool' : np.zeros(NUM_VALIDATORS)
}

# プール残高を保持
pool_balances = {name: 0.0 for name in ['StakePool', 'EqualPool', 'RootStakePool']}

# √stake用ウェイト
root_weights        = np.sqrt(stakes)
total_root_weight   = root_weights.sum()

# メインループ 
for b in range(NUM_BLOCKS):
    # ステーク比でプロポーザを抽選
    proposer = RNG.choice(NUM_VALIDATORS, p=stakes / total_stake)
    mev      = mev_values[b]
    
    # 閾値超過分と保持分を計算
    surplus  = max(0.0, mev - threshold)
    keep     = mev - surplus
    
    # 各シナリオでの処理 
    # Baseline：全取り
    earnings['Baseline'][proposer] += mev
    
    # StakePool：保持分はproposer、超過分はプール
    earnings['StakePool'][proposer] += keep
    pool_balances['StakePool']      += surplus
    
    # EqualPool：保持分はproposer、超過分はプール
    earnings['EqualPool'][proposer] += keep
    pool_balances['EqualPool']      += surplus
    
    # RootStakePool：保持分はproposer、超過分はプール
    earnings['RootStakePool'][proposer] += keep
    pool_balances['RootStakePool']      += surplus
    
    #  エポック境界ならプールを分配 
    if (b + 1) % EPOCH_SIZE == 0:
        # StakePool：ステーク比例
        earnings['StakePool'] += stakes * (pool_balances['StakePool'] / total_stake)
        pool_balances['StakePool'] = 0.0
        
        # EqualPool：人数で等分
        earnings['EqualPool'] += pool_balances['EqualPool'] / NUM_VALIDATORS
        pool_balances['EqualPool'] = 0.0
        
        # RootStakePool：√stake比例
        earnings['RootStakePool'] += root_weights * (pool_balances['RootStakePool'] / total_root_weight)
        pool_balances['RootStakePool'] = 0.0

# 集計
summary_rows = []
for name, arr in earnings.items():
    summary_rows.append({
        'Scenario' : name,
        'Mean'     : np.mean(arr),
        'Std Dev'  : np.std(arr),
        'Gini'     : gini(arr)
    })
summary = pd.DataFrame(summary_rows)
print("=== Profit Distribution Summary ===")
print(summary.to_string(index=False), end="\n\n")

# ベースラインで収益上位5名を抽出し比較
baseline_top = np.argsort(-earnings['Baseline'])[:5]
top_df = pd.DataFrame({
    'Validator'     : baseline_top,
    'Baseline'      : earnings['Baseline'][baseline_top],
    'StakePool'     : earnings['StakePool'][baseline_top],
    'EqualPool'     : earnings['EqualPool'][baseline_top],
    'RootStakePool' : earnings['RootStakePool'][baseline_top]
})
print("=== Top 5 Validators Earnings Comparison ===")
print(top_df.to_string(index=False))