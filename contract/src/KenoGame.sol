// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ParimutuelGame.sol";

/**
 * @title KenoGame
 * @notice Parimutuel keno.
 * @dev 10 numbers are drawn from 1-40. Outcome packed: each number uses 6 bits (0-39) + 1 stored as number.
 *      Players pick 5 numbers packed into betValue as:
 *        n1 | (n2 << 8) | (n3 << 16) | (n4 << 24) | (n5 << 32)
 *      All picks are 1-40.
 *
 *      Bet types (tiers):
 *        0 = MATCH_5  wins if all 5 picks are drawn
 *        1 = MATCH_4  wins if exactly 4 of 5 picks are drawn
 *        2 = MATCH_3  wins if exactly 3 of 5 picks are drawn
 *        3 = MATCH_0  wins if none of the 5 picks are drawn
 */
contract KenoGame is ParimutuelGame {
    uint256 private constant DRAW_COUNT = 10;
    uint256 private constant MAX_NUMBER = 40;
    uint256 private constant PICK_COUNT = 5;

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
        uint256 outcome = 0;
        uint256 used;
        for (uint256 i = 0; i < DRAW_COUNT; i++) {
            uint256 num = ((rng >> (i * 12)) % MAX_NUMBER) + 1;
            // Deduplicate: if collision, increment until free.
            while ((used & (1 << (num - 1))) != 0) {
                num = num % MAX_NUMBER + 1;
            }
            used |= (1 << (num - 1));
            outcome |= (num & 0x3F) << (i * 6);
        }
        return outcome;
    }

    function _decodePicks(uint256 betValue) internal pure returns (uint256[PICK_COUNT] memory picks) {
        for (uint256 i = 0; i < PICK_COUNT; i++) {
            picks[i] = (betValue >> (i * 8)) & 0xFF;
        }
    }

    function _countMatches(uint256 outcome, uint256[PICK_COUNT] memory picks)
        internal
        pure
        returns (uint256 count)
    {
        for (uint256 i = 0; i < PICK_COUNT; i++) {
            uint256 pick = picks[i];
            if (pick == 0 || pick > MAX_NUMBER) continue;
            uint256 mask = 1 << (pick - 1);
            for (uint256 j = 0; j < DRAW_COUNT; j++) {
                uint256 drawn = (outcome >> (j * 6)) & 0x3F;
                if (drawn == pick) {
                    count++;
                    break;
                }
            }
        }
    }

    function _isWinningBet(
        Bet memory bet,
        uint256 winningOutcome,
        address /*player*/,
        uint256 /* roundId */
    ) internal pure override returns (bool) {
        uint8 t = bet.betType;
        uint256[PICK_COUNT] memory picks = _decodePicks(bet.betValue);
        uint256 matches = _countMatches(winningOutcome, picks);

        if (t == 0) return matches == 5;
        if (t == 1) return matches == 4;
        if (t == 2) return matches == 3;
        if (t == 3) return matches == 0;
        return false;
    }
}
