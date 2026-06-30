// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/BlockBingoGame.sol";
import "../src/ParimutuelGame.sol";

contract BlockBingoGameTest is Test {
    BlockBingoGame game;
    address alice = makeAddr("alice");
    // Per-block hashes crafted so each block contributes the next 5 numbers
    // (1..25 total) after the draw-level deduplication loop.
    uint256[5] blockHashes = [uint256(75), 5, 10, 15, 20];

    function setUp() public {
        game = new BlockBingoGame(address(this), 10, 500, 100);
        vm.deal(alice, 10 ether);
        game.setMinBet(0);
        game.setMinPool(0);
        game.setMinBettors(1);
        game.setSettlementBounty(0);
    }

    function _settle(uint256 roundId) internal {
        uint256 resBlock = game.resolutionBlockForRound(roundId);
        vm.roll(resBlock);
        for (uint256 i = 0; i < 5; i++) {
            uint256 b = resBlock >= 4 ? resBlock - 4 + i : i;
            vm.setBlockhash(b, bytes32(blockHashes[i]));
        }
        vm.roll(resBlock + 1);
        game.settleRound(roundId);
    }

    function _hasBingoInTop25(uint8[25] memory card) internal pure returns (bool) {
        // Rows
        for (uint256 r = 0; r < 5; r++) {
            bool ok = true;
            for (uint256 c = 0; c < 5; c++) {
                uint256 n = card[r * 5 + c];
                if (n != 0 && n > 25) { ok = false; break; }
            }
            if (ok) return true;
        }
        // Cols
        for (uint256 c = 0; c < 5; c++) {
            bool ok = true;
            for (uint256 r = 0; r < 5; r++) {
                uint256 n = card[r * 5 + c];
                if (n != 0 && n > 25) { ok = false; break; }
            }
            if (ok) return true;
        }
        // Diagonals
        bool d1 = true;
        bool d2 = true;
        for (uint256 i = 0; i < 5; i++) {
            uint256 n1 = card[i * 5 + i];
            if (n1 != 0 && n1 > 25) d1 = false;
            uint256 n2 = card[i * 5 + (4 - i)];
            if (n2 != 0 && n2 > 25) d2 = false;
        }
        return d1 || d2;
    }

    function _findRoundWithBingo() internal returns (uint256) {
        uint256 start = game.currentRoundId();
        for (uint256 r = start; r < start + 100; r++) {
            vm.roll(r * 10);
            uint8[25] memory card = game.previewCard(alice, r);
            if (_hasBingoInTop25(card)) return r;
        }
        revert("no bingo round found");
    }

    function _findRoundWithoutBingo() internal returns (uint256) {
        uint256 start = game.currentRoundId();
        for (uint256 r = start; r < start + 500; r++) {
            vm.roll(r * 10);
            uint8[25] memory card = game.previewCard(alice, r);
            if (!_hasBingoInTop25(card)) return r;
        }
        revert("no non-bingo round found");
    }

    function test_bingoWins() public {
        uint256 roundId = _findRoundWithBingo();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(0, 0);
        _settle(roundId);
        vm.prank(alice);
        game.claimWinnings(roundId);
    }

    function test_noBingoLoses() public {
        uint256 roundId = _findRoundWithoutBingo();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(0, 0);
        _settle(roundId);
        vm.prank(alice);
        vm.expectRevert(ParimutuelGame.NoWinners.selector);
        game.claimWinnings(roundId);
    }
}
