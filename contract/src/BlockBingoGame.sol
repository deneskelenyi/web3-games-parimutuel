// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ParimutuelGame.sol";

/**
 * @title BlockBingoGame
 * @notice Multi-block bingo parimutuel game.
 * @dev Settlement spans 5 blocks. Each block from resolutionBlock-4 to resolutionBlock
 *      contributes 5 drawn numbers (1-75). Total 25 drawn numbers packed into winningOutcome.
 *      Players buy one bingo card per round. The card is generated deterministically from
 *      hash(player_address, roundId) and contains 24 unique numbers from 1-75 (center FREE).
 *      Bet type 0 = BINGO. A bet wins if the player's card completes any row, column, or diagonal.
 */
contract BlockBingoGame is ParimutuelGame {
    uint256 private constant NUMBERS_PER_BLOCK = 5;
    uint256 private constant BLOCKS = 5;
    uint256 private constant TOTAL_DRAWN = 25; // NUMBERS_PER_BLOCK * BLOCKS
    uint256 private constant MAX_NUMBER = 75;
    uint256 private constant CARD_SIZE = 5;

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
        Round storage r = rounds[roundId];
        uint256 endBlock = r.resolutionBlock;
        // Draw from the 5 blocks leading up to and including the resolution block.
        uint256 startBlock = endBlock >= BLOCKS ? endBlock - (BLOCKS - 1) : 0;

        uint256 outcome = 0;
        uint256 used;
        uint256 slot = 0;
        for (uint256 b = 0; b < BLOCKS; b++) {
            uint256 blockNum = startBlock + b;
            uint256 bh = uint256(blockhash(blockNum));
            if (bh == 0) {
                // Fallback deterministic hash if blockhash unavailable.
                bh = uint256(keccak256(abi.encodePacked(roundId, blockNum, block.timestamp)));
            }
            for (uint256 k = 0; k < NUMBERS_PER_BLOCK; k++) {
                uint256 num = ((bh >> (k * 13)) % MAX_NUMBER) + 1;
                // Deduplicate across the whole 25-number draw.
                while ((used & (1 << (num - 1))) != 0) {
                    num = num % MAX_NUMBER + 1;
                }
                used |= (1 << (num - 1));
                outcome |= (num & 0x7F) << (slot * 7);
                slot++;
            }
        }
        return outcome;
    }

    function previewCard(address player, uint256 roundId) external pure returns (uint8[25] memory) {
        return _generateCard(player, roundId);
    }

    function _generateCard(address player, uint256 roundId)
        internal
        pure
        returns (uint8[25] memory card)
    {
        uint256 seed = uint256(keccak256(abi.encodePacked(player, roundId)));
        uint256 used;
        uint256 placed = 0;
        uint256 nonce = 0;
        while (placed < 24) {
            uint256 num = (uint256(keccak256(abi.encodePacked(seed, nonce))) % MAX_NUMBER) + 1;
            nonce++;
            if ((used & (1 << (num - 1))) != 0) continue;
            used |= (1 << (num - 1));
            card[placed] = uint8(num);
            placed++;
        }
        // Center cell (index 12) is FREE.
        card[12] = 0;
    }

    function _numberDrawn(uint256 outcome, uint256 number) internal pure returns (bool) {
        uint256 mask = 1 << (number - 1);
        for (uint256 i = 0; i < TOTAL_DRAWN; i++) {
            uint256 drawn = (outcome >> (i * 7)) & 0x7F;
            if (drawn == number) {
                return true;
            }
        }
        return false;
    }

    function _hasBingo(uint8[25] memory card, uint256 outcome)
        internal
        pure
        returns (bool)
    {
        // Rows
        for (uint256 r = 0; r < CARD_SIZE; r++) {
            bool complete = true;
            for (uint256 c = 0; c < CARD_SIZE; c++) {
                uint256 num = card[r * CARD_SIZE + c];
                if (num == 0) continue; // FREE
                if (!_numberDrawn(outcome, num)) {
                    complete = false;
                    break;
                }
            }
            if (complete) return true;
        }
        // Columns
        for (uint256 c = 0; c < CARD_SIZE; c++) {
            bool complete = true;
            for (uint256 r = 0; r < CARD_SIZE; r++) {
                uint256 num = card[r * CARD_SIZE + c];
                if (num == 0) continue;
                if (!_numberDrawn(outcome, num)) {
                    complete = false;
                    break;
                }
            }
            if (complete) return true;
        }
        // Diagonals
        bool diag1 = true;
        bool diag2 = true;
        for (uint256 i = 0; i < CARD_SIZE; i++) {
            uint256 num1 = card[i * CARD_SIZE + i];
            if (num1 != 0 && !_numberDrawn(outcome, num1)) diag1 = false;
            uint256 num2 = card[i * CARD_SIZE + (CARD_SIZE - 1 - i)];
            if (num2 != 0 && !_numberDrawn(outcome, num2)) diag2 = false;
        }
        return diag1 || diag2;
    }

    function _isWinningBet(
        Bet memory bet,
        uint256 winningOutcome,
        address player,
        uint256 roundId
    ) internal pure override returns (bool) {
        if (bet.betType != 0) return false;
        uint8[25] memory card = _generateCard(player, roundId);
        return _hasBingo(card, winningOutcome);
    }
}
