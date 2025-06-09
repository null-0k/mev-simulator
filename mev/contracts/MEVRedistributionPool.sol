// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  MEV Redistribution Pool (Stake-Proportional)
/// @notice 余剰MEVをプールし、エポックごとにバリデータへ再配分する簡易実装
/// @dev    本番用途ではオラクル認証、re-entrancy guard、ガス最適化を追加すべき
contract MEVRedistributionPool {
    // ============================================================
    //                            EVENTS
    // ============================================================
    event SurplusDeposited(address indexed proposer, uint256 amount, uint256 epoch);
    event StakeUpdated(address indexed validator, uint256 newStake, uint256 epoch);
    event RewardsDistributed(uint256 totalAmount, uint256 epoch);
    event RewardClaimed(address indexed validator, uint256 amount);

    // ============================================================
    //                           CONSTANTS
    // ============================================================
    /**
     * @notice エポック長を秒単位で固定
     */
    uint256 public immutable EPOCH_LENGTH;

    // ============================================================
    //                      STORAGE - PUBLIC VIEW
    // ============================================================
    /**
     * @notice 現在エポック番号（timestamp / EPOCH_LENGTH 切り捨て）
     */
    function currentEpoch() public view returns (uint256) {
        return block.timestamp / EPOCH_LENGTH;
    }

    /**
     * @notice バリデータごとのステーク重み
     */
    mapping(address => uint256) public stakeOf;
    
    /**
     * @notice エポックごとのプール残高
     */
    mapping(uint256 => uint256) public poolOfEpoch;
    
    /**
     * @notice バリデータがまだ引き出していない報酬額
     */
    mapping(address => uint256) public pendingReward;
    
    /**
     * @notice エポックごとの配分済みプール額を記録
     */
    mapping(uint256 => uint256) public distributedPoolOfEpoch;
    
    /**
     * @notice バリデータがエポックから既に引き出したか
     */
    mapping(address => mapping(uint256 => bool)) public hasClaimed;

    /**
     * @notice 直近エポックで集計済みのtotalStake（ガス節約のためキャッシュ）
     */
    mapping(uint256 => uint256) public totalStakeAtEpoch;

    // ============================================================
    //                          MODIFIERS
    // ============================================================
    /**
     * @notice ステーク情報のアップデート権限。ここではオーナのみ
     */
    address public immutable owner;

    modifier onlyOwner() {
        require(msg.sender == owner, "not authorized");
        _;
    }

    // ============================================================
    //                          CONSTRUCTOR
    // ============================================================
    constructor(uint256 _epochLength) {
        require(_epochLength > 0, "epoch length = 0");
        EPOCH_LENGTH = _epochLength;
        owner        = msg.sender;
    }

    // ============================================================
    //                    SURPLUS DEPOSIT INTERFACE
    // ============================================================
    /**
     * @notice プロポーザが入金
     */
    function depositSurplus() external payable {
        require(msg.value > 0, "no value");
        uint256 ep = currentEpoch();
        poolOfEpoch[ep] += msg.value;
        emit SurplusDeposited(msg.sender, msg.value, ep);
    }

    // ============================================================
    //                    STAKE ORACLE INTERFACE
    // ============================================================
    /**
     * @notice オラクルがバリデータのステークを更新する
     */
    function updateStake(address validator, uint256 newStake) external onlyOwner {
        uint256 ep = currentEpoch();
        // 古い重みを引き、合計を更新
        uint256 prev = stakeOf[validator];
        stakeOf[validator] = newStake;

        // キャッシュされていない場合は初期化
        if (totalStakeAtEpoch[ep] == 0) {
            totalStakeAtEpoch[ep] = totalStakeAtEpoch[ep - 1];
        }

        totalStakeAtEpoch[ep] = totalStakeAtEpoch[ep] + newStake - prev;
        emit StakeUpdated(validator, newStake, ep);
    }

    // ============================================================
    //                      DISTRIBUTION LOGIC
    // ============================================================
    /**
     * @notice エポックが切り替わったあと誰でも呼べる
     */
    function distribute(uint256 epoch) external {
        require(epoch < currentEpoch(), "epoch not finished");
        uint256 pool = poolOfEpoch[epoch];
        require(pool > 0, "already distributed");

        uint256 totalStake = totalStakeAtEpoch[epoch];
        require(totalStake > 0, "totalStake=0");

        // 配分済みプール額を記録
        distributedPoolOfEpoch[epoch] = pool;
        poolOfEpoch[epoch] = 0; // re-entrancy 対策
        emit RewardsDistributed(pool, epoch);
    }

    // ============================================================
    //                       CLAIM INTERFACE
    // ============================================================
    /**
     * @notice バリデータが任意エポックの報酬を取り出す
     */
    function claim(uint256 epoch) public {
        require(epoch < currentEpoch(), "epoch ongoing");
        require(distributedPoolOfEpoch[epoch] > 0, "not yet distributed");
        require(!hasClaimed[msg.sender][epoch], "already claimed");

        uint256 stake = stakeOf[msg.sender];
        uint256 totalStake = totalStakeAtEpoch[epoch];
        require(totalStake > 0, "totalStake=0");
        
        uint256 poolAmount = distributedPoolOfEpoch[epoch];
        uint256 share = (poolAmount * stake) / totalStake;
        require(share > 0, "no reward");

        hasClaimed[msg.sender][epoch] = true;
        (bool ok, ) = msg.sender.call{value: share}("");
        require(ok, "transfer failed");
        emit RewardClaimed(msg.sender, share);
    }

    /**
     * @notice まとめてclaimするユーティリティ
     */
    function claimMany(uint256[] calldata epochs) external {
        for (uint256 i = 0; i < epochs.length; ++i) {
            claim(epochs[i]);
        }
    }

    // ============================================================
    //               VIEW HELPERS (ガスを使わない情報参照)
    // ============================================================
    /**
     * @dev ステーク比例以外の分配方式に切り替えたい場合はここを書き換える
     */
    function weightOf(address validator) public view returns (uint256) {
        return stakeOf[validator]; // √stakeならsqrt(stakeOf[validator])
    }

    /**
     * @notice エポック終了後まだclaimしていない見込額をオフチェーンから確認
     */
    function estimateClaim(address validator, uint256 epoch) external view returns (uint256) {
        if (epoch >= currentEpoch()) return 0;
        if (distributedPoolOfEpoch[epoch] == 0) return 0;  // distribute未実行
        if (hasClaimed[validator][epoch]) return 0;  // 既に引き出し済み
        uint256 stake = stakeOf[validator];
        uint256 totalStake = totalStakeAtEpoch[epoch];
        if (totalStake == 0) return 0;
        return (distributedPoolOfEpoch[epoch] * stake) / totalStake;
    }
}