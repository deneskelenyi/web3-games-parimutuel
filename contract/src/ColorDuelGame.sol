// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ParimutuelGame.sol";

/**
 * @title ColorDuelGame
 * @notice Three-color parimutuel duel.
 * @dev Outcome is 0, 1, or 2 derived from the resolution blockhash.
 *      0 = RED wins
 *      1 = GREEN wins
 *      2 = BLUE wins
 *      A bet wins when bet.betType == winningOutcome.
 */
contract ColorDuelGame is ParimutuelGame {
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
        return _getRNG(roundId) % 3;
    }

    function _isWinningBet(
        Bet memory bet,
        uint256 winningOutcome,
        address player,
        uint256 roundId
    ) internal pure override returns (bool) {
        return bet.betType == winningOutcome;
    }
}
