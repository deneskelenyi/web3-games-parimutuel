// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ParimutuelGame.sol";

/**
 * @title CoinFlipStreakGame
 * @notice Count leading heads before the first tails.
 * @dev The resolution blockhash seeds 20 coin flips.
 *      flips[i] = (rng >> i) & 1 for i in 0..19
 *      streak = count of leading 1s before first 0
 *      (if all 20 are 1, streak = 20)
 *      Outcome: 0-20
 *
 *      Bet types (buckets):
 *        0 = STREAK_0     wins if streak == 0
 *        1 = STREAK_1     wins if streak == 1
 *        2 = STREAK_2     wins if streak == 2
 *        3 = STREAK_3     wins if streak == 3
 *        4 = STREAK_4     wins if streak == 4
 *        5 = STREAK_5     wins if streak == 5
 *        6 = STREAK_6PLUS wins if streak >= 6
 */
contract CoinFlipStreakGame is ParimutuelGame {
    uint256 public constant FLIPS = 20;

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
        uint256 rng = _getRNG(roundId);
        uint256 streak = 0;
        for (uint256 i = 0; i < FLIPS; i++) {
            if (((rng >> i) & 1) == 1) {
                streak++;
            } else {
                break;
            }
        }
        return streak;
    }

    function _isWinningBet(
        Bet memory bet,
        uint256 winningOutcome,
        address player,
        uint256 roundId
    ) internal pure override returns (bool) {
        uint8 bucket = bet.betType;
        if (bucket <= 5) return winningOutcome == bucket;
        if (bucket == 6) return winningOutcome >= 6;
        return false;
    }
}
