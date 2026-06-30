// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ParimutuelGame.sol";

/**
 * @title DiceGame
 * @notice Dice Over/Under parimutuel game.
 * @dev Outcome is a number 0-99 derived from the resolution blockhash.
 *      0 = OVER wins if outcome > 50
 *      1 = UNDER wins if outcome < 50
 *      Outcome 50 is a dead zone: nobody wins and the prize pool rolls into the jackpot.
 */
contract DiceGame is ParimutuelGame {
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
        return _getRNG(roundId) % 100;
    }

    function _isWinningBet(
        Bet memory bet,
        uint256 winningOutcome,
        address player,
        uint256 roundId
    ) internal pure override returns (bool) {
        // Dead zone: nobody wins.
        if (winningOutcome == 50) return false;

        // OVER
        if (bet.betType == 0) {
            return winningOutcome > 50;
        }

        // UNDER
        if (bet.betType == 1) {
            return winningOutcome < 50;
        }

        return false;
    }
}
