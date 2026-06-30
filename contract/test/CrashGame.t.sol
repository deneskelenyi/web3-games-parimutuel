// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/CrashGame.sol";

contract CrashGameTest is Test {
    CrashGame public game;

    address public alice;
    address public bob;
    address public settler;

    uint256 public constant BLOCKS_PER_ROUND = 1;
    uint256 public constant HOUSE_EDGE_BPS = 500;
    uint256 public constant BOUNTY_BPS = 10;

    function setUp() public {
        game = new CrashGame(address(this), BLOCKS_PER_ROUND, HOUSE_EDGE_BPS, BOUNTY_BPS);
        game.setMinBettors(1);
        game.setMinPool(0);
        game.setMinBet(0.0001 ether);
        game.setClaimExpiryBlocks(0);
        game.setCarryOverLimit(3);

        alice = makeAddr("alice");
        bob = makeAddr("bob");
        settler = makeAddr("settler");
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(settler, 1 ether);
    }

    function _bet(address player, uint8 betType, uint256 amount) internal {
        vm.prank(player);
        game.placeBet{value: amount}(betType, 0);
    }

    function _goToBettingBlock(uint256 roundId) internal {
        uint256 resBlock = game.resolutionBlockForRound(roundId);
        vm.roll(resBlock - 1);
    }

    function _settle(uint256 roundId, uint256 outcome) internal {
        (uint256 resBlock,,,,,,,,) = game.rounds(roundId);
        vm.roll(resBlock);
        vm.setBlockhash(resBlock, bytes32(outcome));
        vm.roll(resBlock + 1);
        vm.prank(settler);
        game.settleRound(roundId);
    }

    function test_placeBet() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 1, 1 ether); // 2x tier

        (, uint256 totalPool,,,,,,,) = game.rounds(roundId);
        assertEq(totalPool, 1 ether);
        assertEq(game.roundBettorCount(roundId), 1);
    }

    function test_tier1_5xWins() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 1 ether); // 1.5x tier
        _settle(roundId, 200);   // 2.00x crash point

        (, , , uint256 winningOutcome,,,,,) = game.rounds(roundId);
        assertEq(winningOutcome, 200);
        assertTrue(game.hasUnclaimedBets(roundId, alice));
    }

    function test_tier10xWins() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 4, 1 ether); // 10x tier
        _settle(roundId, 1500);  // 15.00x crash point

        (, , , uint256 winningOutcome,,,,,) = game.rounds(roundId);
        assertEq(winningOutcome, 1500);
        assertTrue(game.hasUnclaimedBets(roundId, alice));
    }

    function test_lowerTierLosesWhenCrashBelowThreshold() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 2, 1 ether); // 3x tier needs >= 300
        _settle(roundId, 250);   // 2.50x crash point

        (, , , uint256 winningOutcome,,, bool settled,, bool hasWinners) = game.rounds(roundId);
        assertEq(winningOutcome, 250);
        assertTrue(settled);
        assertFalse(hasWinners);
    }

    function test_splitPoolProportional() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 1 ether); // 1.5x tier survives at 1500
        _bet(bob, 4, 2 ether);   // 10x tier survives at 1500
        _settle(roundId, 1500);  // 15.00x crash point

        vm.prank(alice);
        game.claimWinnings(roundId);

        (, uint256 totalPool, uint256 totalWinningBets,, uint256 prizePool,,,,) = game.rounds(roundId);
        assertEq(totalWinningBets, 3 ether);
        assertEq(totalPool, 3 ether);
        // Break-even floor returns house cut because all bets win.
        uint256 bounty = Math.mulDiv(totalPool, BOUNTY_BPS, 10000);
        assertEq(prizePool, totalPool - bounty);
    }

    function test_instantCrashNoWinners() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 1 ether); // 1.5x tier
        _settle(roundId, 50);    // 0.50x crash point, below all tiers

        (, , , uint256 winningOutcome,,, bool settled,, bool hasWinners) = game.rounds(roundId);
        assertEq(winningOutcome, 100); // min 100
        assertTrue(settled);
        assertFalse(hasWinners);
        assertGt(game.jackpot(), 0);
    }

    function test_bettorCountWithMultipleBets() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 0.5 ether);
        _bet(alice, 1, 0.5 ether);
        assertEq(game.roundBettorCount(roundId), 1);
    }
}
