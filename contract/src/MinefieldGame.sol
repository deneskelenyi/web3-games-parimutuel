// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ParimutuelGame.sol";

/**
 * @title MinefieldGame
 * @notice Parimutuel minefield.
 * @dev 5 mines are placed on a 5x5 grid (cells 0-24).
 *      Outcome is the packed positions of the 5 mines (5 bits each).
 *
 *      Bet types:
 *        0 = SAFE  betValue = cell (0-24), wins if cell is NOT a mine
 *        1 = MINE  betValue = cell (0-24), wins if cell IS a mine
 */
contract MinefieldGame is ParimutuelGame {
    uint256 private constant GRID_SIZE = 25;
    uint256 private constant MINE_COUNT = 5;

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
        uint256 placed = 0;
        uint256 shift = 0;
        while (placed < MINE_COUNT) {
            uint256 cell = (rng >> shift) % GRID_SIZE;
            shift += 13;
            if ((used & (1 << cell)) != 0) continue;
            used |= (1 << cell);
            outcome |= (cell & 0x1F) << (placed * 5);
            placed++;
        }
        return outcome;
    }

    function _isMine(uint256 outcome, uint256 cell) internal pure returns (bool) {
        for (uint256 i = 0; i < MINE_COUNT; i++) {
            uint256 mine = (outcome >> (i * 5)) & 0x1F;
            if (mine == cell) return true;
        }
        return false;
    }

    function _isWinningBet(
        Bet memory bet,
        uint256 winningOutcome,
        address /*player*/,
        uint256 /* roundId */
    ) internal pure override returns (bool) {
        uint8 t = bet.betType;
        uint256 cell = bet.betValue;
        if (cell >= GRID_SIZE) return false;
        bool mine = _isMine(winningOutcome, cell);
        if (t == 0) return !mine;
        if (t == 1) return mine;
        return false;
    }
}
