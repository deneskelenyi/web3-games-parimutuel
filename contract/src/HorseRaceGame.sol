// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ParimutuelGame.sol";

/**
 * @title HorseRaceGame
 * @notice Virtual horse race parimutuel game.
 * @dev Six horses get random scores from the resolution blockhash.
 *      Outcome is the packed finishing order: 6 nibbles (each 0-5), first nibble = 1st place horse.
 *
 *      Bet types:
 *        0 = WIN    betValue = horse (0-5), wins if horse finishes 1st
 *        1 = PLACE  betValue = horse (0-5), wins if horse finishes 1st or 2nd
 *        2 = SHOW   betValue = horse (0-5), wins if horse finishes in top 3
 *        3 = EXACTA betValue = (firstHorse << 4) | secondHorse, wins if exact top-2 order
 */
contract HorseRaceGame is ParimutuelGame {
    uint256 private constant HORSE_COUNT = 6;
    uint256 private constant SCORE_MOD = 1000;

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
        uint256[HORSE_COUNT] memory scores;
        for (uint256 i = 0; i < HORSE_COUNT; i++) {
            scores[i] = (rng >> (i * 10)) % SCORE_MOD;
        }

        // Sort horses by score descending using simple insertion sort.
        uint256[HORSE_COUNT] memory order;
        for (uint256 i = 0; i < HORSE_COUNT; i++) {
            order[i] = i;
        }
        for (uint256 i = 1; i < HORSE_COUNT; i++) {
            uint256 keyScore = scores[i];
            uint256 keyHorse = order[i];
            int256 j = int256(i) - 1;
            while (j >= 0 && scores[uint256(j)] < keyScore) {
                scores[uint256(j) + 1] = scores[uint256(j)];
                order[uint256(j) + 1] = order[uint256(j)];
                j--;
            }
            scores[uint256(j) + 1] = keyScore;
            order[uint256(j) + 1] = keyHorse;
        }

        uint256 outcome = 0;
        for (uint256 i = 0; i < HORSE_COUNT; i++) {
            outcome |= (order[i] & 0xF) << (i * 4);
        }
        return outcome;
    }

    function _isWinningBet(
        Bet memory bet,
        uint256 winningOutcome,
        address /*player*/,
        uint256 /* roundId */
    ) internal pure override returns (bool) {
        uint8 t = bet.betType;
        uint256 v = bet.betValue;
        uint256 first = winningOutcome & 0xF;
        uint256 second = (winningOutcome >> 4) & 0xF;
        uint256 third = (winningOutcome >> 8) & 0xF;

        if (t == 0) return v == first;
        if (t == 1) return v == first || v == second;
        if (t == 2) return v == first || v == second || v == third;
        if (t == 3) {
            uint256 expectedFirst = (v >> 4) & 0xF;
            uint256 expectedSecond = v & 0xF;
            return first == expectedFirst && second == expectedSecond;
        }
        return false;
    }
}
