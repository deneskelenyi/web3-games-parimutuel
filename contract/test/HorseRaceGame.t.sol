// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/HorseRaceGame.sol";
import "../src/ParimutuelGame.sol";

contract HorseRaceGameTest is Test {
    HorseRaceGame game;
    address alice = makeAddr("alice");

    function setUp() public {
        game = new HorseRaceGame(address(this), 10, 500, 100);
        vm.deal(alice, 10 ether);
        game.setMinBet(0);
        game.setMinPool(0);
        game.setMinBettors(1);
        game.setSettlementBounty(0);
    }

    function _settle(uint256 roundId, uint256 blockHashNum) internal {
        uint256 resBlock = game.resolutionBlockForRound(roundId);
        vm.roll(resBlock);
        vm.setBlockhash(resBlock, bytes32(uint256(blockHashNum)));
        vm.roll(resBlock + 1);
        game.settleRound(roundId);
    }

    function test_winWins() public {
        uint256 roundId = game.currentRoundId();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(0, 0); // WIN horse 0
        _settle(roundId, 1); // outcome top-2 = (0,1)
        vm.prank(alice);
        game.claimWinnings(roundId);
    }

    function test_placeWins() public {
        uint256 roundId = game.currentRoundId();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(1, 1); // PLACE horse 1 (finishes 2nd)
        _settle(roundId, 1);
        vm.prank(alice);
        game.claimWinnings(roundId);
    }

    function test_showWins() public {
        uint256 roundId = game.currentRoundId();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(2, 2); // SHOW horse 2 (top 3)
        _settle(roundId, 1);
        vm.prank(alice);
        game.claimWinnings(roundId);
    }

    function test_showLoses() public {
        uint256 roundId = game.currentRoundId();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(2, 5); // SHOW horse 5 (finishes 6th)
        _settle(roundId, 1);
        vm.prank(alice);
        vm.expectRevert(ParimutuelGame.NoWinners.selector);
        game.claimWinnings(roundId);
    }

    function test_exactaWins() public {
        uint256 roundId = game.currentRoundId();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(3, (0 << 4) | 1); // exacta 0 then 1
        _settle(roundId, 1);
        vm.prank(alice);
        game.claimWinnings(roundId);
    }

    function test_exactaLoses() public {
        uint256 roundId = game.currentRoundId();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(3, (1 << 4) | 0); // exacta 1 then 0
        _settle(roundId, 1); // actual order 0 then 1
        vm.prank(alice);
        vm.expectRevert(ParimutuelGame.NoWinners.selector);
        game.claimWinnings(roundId);
    }
}
