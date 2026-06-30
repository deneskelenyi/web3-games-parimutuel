// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ParimutuelGame.sol";

/**
 * @title RouletteGame
 * @notice European-style parimutuel roulette.
 * @dev Outcome is 0-36 derived from the resolution blockhash.
 *      0 is green (no outside bets win; only single-zero bets win).
 *      Red numbers: 1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36
 *      Black numbers: 2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35
 *
 *      Bet types:
 *        0 = RED          (betValue unused)
 *        1 = BLACK        (betValue unused)
 *        2 = EVEN         (betValue unused)
 *        3 = ODD          (betValue unused)
 *        4 = HIGH (19-36) (betValue unused)
 *        5 = LOW  (1-18)  (betValue unused)
 *        6 = SINGLE       (betValue = number 0-36)
 */
contract RouletteGame is ParimutuelGame {
    // Red numbers set for quick lookup.
    uint256 private constant RED_MASK =
        (1 << 1) | (1 << 3) | (1 << 5) | (1 << 7) | (1 << 9) |
        (1 << 12) | (1 << 14) | (1 << 16) | (1 << 18) | (1 << 19) |
        (1 << 21) | (1 << 23) | (1 << 25) | (1 << 27) | (1 << 30) |
        (1 << 32) | (1 << 34) | (1 << 36);

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
        return _getRNG(roundId) % 37;
    }

    function _isWinningBet(
        Bet memory bet,
        uint256 winningOutcome,
        address player,
        uint256 roundId
    ) internal pure override returns (bool) {
        uint8 t = bet.betType;
        if (winningOutcome == 0) {
            // Only single-zero bets win on 0.
            return t == 6 && bet.betValue == 0;
        }

        if (t == 0) return _isRed(winningOutcome);
        if (t == 1) return !_isRed(winningOutcome);
        if (t == 2) return winningOutcome % 2 == 0;
        if (t == 3) return winningOutcome % 2 == 1;
        if (t == 4) return winningOutcome >= 19;
        if (t == 5) return winningOutcome <= 18;
        if (t == 6) return bet.betValue == winningOutcome;
        return false;
    }

    function _isRed(uint256 number) internal pure returns (bool) {
        if (number == 0 || number > 36) return false;
        return (RED_MASK & (uint256(1) << number)) != 0;
    }
}
