// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/KenoGame.sol";
import "../src/ParimutuelGame.sol";

contract KenoGameTest is Test {
    KenoGame game;
    address alice = makeAddr("alice");

    function setUp() public {
        game = new KenoGame(address(this), 10, 500, 100);
        vm.deal(alice, 10 ether);
        game.setMinBet(0);
        game.setMinPool(0);
        game.setMinBettors(1);
        game.setSettlementBounty(0);
    }

    function _pack(uint256 a, uint256 b, uint256 c, uint256 d, uint256 e)
        internal pure returns (uint256)
    {
        return a | (b << 8) | (c << 16) | (d << 24) | (e << 32);
    }

    function _settle(uint256 roundId, uint256 blockHashNum) internal {
        uint256 resBlock = game.resolutionBlockForRound(roundId);
        vm.roll(resBlock);
        vm.setBlockhash(resBlock, bytes32(uint256(blockHashNum)));
        vm.roll(resBlock + 1);
        game.settleRound(roundId);
    }

    function test_match5Wins() public {
        uint256 roundId = game.currentRoundId();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        // blockhash=1 draws numbers [2,1,3,4,5,6,7,8,9,10]
        game.placeBet{value: 1 ether}(0, _pack(1, 2, 3, 4, 5));
        _settle(roundId, 1);
        vm.prank(alice);
        game.claimWinnings(roundId);
    }

    function test_match4Wins() public {
        uint256 roundId = game.currentRoundId();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(1, _pack(1, 2, 3, 4, 11));
        _settle(roundId, 1);
        vm.prank(alice);
        game.claimWinnings(roundId);
    }

    function test_match3Wins() public {
        uint256 roundId = game.currentRoundId();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(2, _pack(1, 2, 3, 12, 13));
        _settle(roundId, 1);
        vm.prank(alice);
        game.claimWinnings(roundId);
    }

    function test_match0Wins() public {
        uint256 roundId = game.currentRoundId();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(3, _pack(31, 32, 33, 34, 35));
        _settle(roundId, 1);
        vm.prank(alice);
        game.claimWinnings(roundId);
    }

    function test_match5Loses() public {
        uint256 roundId = game.currentRoundId();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(0, _pack(31, 32, 33, 34, 35));
        _settle(roundId, 1);
        vm.prank(alice);
        vm.expectRevert(ParimutuelGame.NoWinners.selector);
        game.claimWinnings(roundId);
    }
}
