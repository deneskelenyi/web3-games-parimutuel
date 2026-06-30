// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ParimutuelGame.sol";

/**
 * @title SlotsGame
 * @notice Parimutuel slot machine.
 * @dev Three reels, each showing one of 8 symbols.
 *      Symbols: 0=cherry, 1=lemon, 2=bell, 3=bar, 4=seven, 5=diamond, 6=star, 7=crown
 *      Outcome is packed as (symbol1 << 8) | (symbol2 << 4) | symbol3.
 *
 *      Bet types:
 *        0 = EXACT_TRIPLE  betValue = symbol (0-7), wins if all 3 reels match betValue
 *        1 = ANY_TRIPLE    wins if all 3 reels match each other (any symbol)
 *        2 = ANY_PAIR      wins if any 2 of the 3 reels match
 *        3 = FIRST_SYMBOL  betValue = symbol (0-7), wins if first reel == betValue
 */
contract SlotsGame is ParimutuelGame {
    uint256 private constant SYMBOL_MASK = 0x7;

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
        uint256 s1 = rng & SYMBOL_MASK;
        uint256 s2 = (rng >> 3) & SYMBOL_MASK;
        uint256 s3 = (rng >> 6) & SYMBOL_MASK;
        return (s1 << 8) | (s2 << 4) | s3;
    }

    function _decodeOutcome(uint256 outcome) internal pure returns (uint256, uint256, uint256) {
        uint256 s1 = (outcome >> 8) & SYMBOL_MASK;
        uint256 s2 = (outcome >> 4) & SYMBOL_MASK;
        uint256 s3 = outcome & SYMBOL_MASK;
        return (s1, s2, s3);
    }

    function _isWinningBet(
        Bet memory bet,
        uint256 winningOutcome,
        address /*player*/,
        uint256 /* roundId */
    ) internal pure override returns (bool) {
        (uint256 s1, uint256 s2, uint256 s3) = _decodeOutcome(winningOutcome);
        uint8 t = bet.betType;
        uint256 v = bet.betValue;

        if (t == 0) return s1 == v && s2 == v && s3 == v;
        if (t == 1) return s1 == s2 && s2 == s3;
        if (t == 2) return s1 == s2 || s1 == s3 || s2 == s3;
        if (t == 3) return s1 == v;
        return false;
    }
}
