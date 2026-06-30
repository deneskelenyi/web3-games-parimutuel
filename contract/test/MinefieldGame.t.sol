// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/MinefieldGame.sol";
import "../src/ParimutuelGame.sol";

contract MinefieldGameTest is Test {
    MinefieldGame game;
    address alice = makeAddr("alice");
    // rng with 13-bit chunks 0,1,2,3,4 => mines at cells 0,1,2,3,4
    uint256 constant RNG = 18016047911149568;

    function setUp() public {
        game = new MinefieldGame(address(this), 10, 500, 100);
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

    function test_safeWins() public {
        uint256 roundId = game.currentRoundId();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(0, 5); // SAFE on cell 5
        _settle(roundId, RNG);
        vm.prank(alice);
        game.claimWinnings(roundId);
    }

    function test_mineWins() public {
        uint256 roundId = game.currentRoundId();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(1, 0); // MINE on cell 0
        _settle(roundId, RNG);
        vm.prank(alice);
        game.claimWinnings(roundId);
    }

    function test_safeLoses() public {
        uint256 roundId = game.currentRoundId();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(0, 0); // SAFE on a mine
        _settle(roundId, RNG);
        vm.prank(alice);
        vm.expectRevert(ParimutuelGame.NoWinners.selector);
        game.claimWinnings(roundId);
    }

    function test_mineLoses() public {
        uint256 roundId = game.currentRoundId();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(1, 5); // MINE on safe cell
        _settle(roundId, RNG);
        vm.prank(alice);
        vm.expectRevert(ParimutuelGame.NoWinners.selector);
        game.claimWinnings(roundId);
    }
}
