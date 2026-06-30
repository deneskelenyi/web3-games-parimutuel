// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ParimutuelGame.sol";

/**
 * @title CrashGame
 * @notice Rocket crash parimutuel game.
 * @dev RNG gives a value 0-9999. crashPoint = max(100, rng) / 100 => 1.00x - 100.00x.
 *      The stored winningOutcome is crashPoint * 100 (integer, e.g. 237 = 2.37x).
 *      Bet types are tiers that survive if the crash point is at least their threshold:
 *        0 = TIER_1_5X  (>= 1.50x, outcome >= 150)
 *        1 = TIER_2X    (>= 2.00x, outcome >= 200)
 *        2 = TIER_3X    (>= 3.00x, outcome >= 300)
 *        3 = TIER_5X    (>= 5.00x, outcome >= 500)
 *        4 = TIER_10X   (>= 10.00x, outcome >= 1000)
 *      All surviving tiers share one pool proportionally.
 */
contract CrashGame is ParimutuelGame {
    // Tier thresholds as crashPoint * 100
    uint256 public constant TIER_1_5X = 150;
    uint256 public constant TIER_2X = 200;
    uint256 public constant TIER_3X = 300;
    uint256 public constant TIER_5X = 500;
    uint256 public constant TIER_10X = 1000;

    constructor(
        address house,
        uint256 blocksPerRound,
        uint256 houseEdgeBps,
        uint256 settlementBountyBps
    )
        ParimutuelGame(
            house,
            blocksPerRound,
            houseEdgeBps,
            settlementBountyBps
        )
    {}

    function _determineOutcome(uint256 roundId) internal view override returns (uint256) {
        uint256 rng = _getRNG(roundId) % 10000;
        // Ensure minimum 1.00x; outcome stored as crashPoint * 100
        return rng < 100 ? 100 : rng;
    }

    function _isWinningBet(
        Bet memory bet,
        uint256 winningOutcome,
        address player,
        uint256 roundId
    ) internal pure override returns (bool) {
        uint8 tier = bet.betType;
        if (tier == 0) return winningOutcome >= TIER_1_5X;
        if (tier == 1) return winningOutcome >= TIER_2X;
        if (tier == 2) return winningOutcome >= TIER_3X;
        if (tier == 3) return winningOutcome >= TIER_5X;
        if (tier == 4) return winningOutcome >= TIER_10X;
        return false;
    }
}
