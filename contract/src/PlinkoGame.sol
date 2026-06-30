// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ParimutuelGame.sol";

/**
 * @title PlinkoGame
 * @notice Plinko-style parimutuel game.
 * @dev The resolution blockhash seeds 12 binary decisions.
 *      path[i] = (rng >> i) & 1 for i in 0..11
 *      landing_zone = sum(path)  →  0 to 12 (13 possible zones)
 *      A bet wins when bet.betValue == landing_zone.
 *      bet.betType is unused (kept 0) and bet.betValue selects the zone 0-12.
 */
contract PlinkoGame is ParimutuelGame {
    uint256 public constant PATH_LENGTH = 12;

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
        uint256 zone = 0;
        for (uint256 i = 0; i < PATH_LENGTH; i++) {
            zone += (rng >> i) & 1;
        }
        return zone;
    }

    function _isWinningBet(
        Bet memory bet,
        uint256 winningOutcome,
        address player,
        uint256 roundId
    ) internal pure override returns (bool) {
        return bet.betValue == winningOutcome;
    }
}
