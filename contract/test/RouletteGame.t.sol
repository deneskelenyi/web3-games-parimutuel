// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/RouletteGame.sol";

contract RouletteGameTest is Test {
    RouletteGame public game;

    address public alice;
    address public bob;
    address public settler;

    uint256 public constant BLOCKS_PER_ROUND = 1;
    uint256 public constant HOUSE_EDGE_BPS = 500;
    uint256 public constant BOUNTY_BPS = 10;

    function setUp() public {
        game = new RouletteGame(address(this), BLOCKS_PER_ROUND, HOUSE_EDGE_BPS, BOUNTY_BPS);
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

    function _bet(address player, uint8 betType, uint8 betValue, uint256 amount) internal {
        vm.prank(player);
        game.placeBet{value: amount}(betType, betValue);
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
        _bet(alice, 0, 0, 1 ether); // RED

        (, uint256 totalPool,,,,,,,) = game.rounds(roundId);
        assertEq(totalPool, 1 ether);
        assertEq(game.roundBettorCount(roundId), 1);
    }

    function test_redWins() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 0, 1 ether); // RED
        _settle(roundId, 1);         // 1 is red

        (, , , uint256 winningOutcome,,,,,) = game.rounds(roundId);
        assertEq(winningOutcome, 1);
        assertTrue(game.hasUnclaimedBets(roundId, alice));
    }

    function test_blackWins() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 1, 0, 1 ether); // BLACK
        _settle(roundId, 2);         // 2 is black

        (, , , uint256 winningOutcome,,,,,) = game.rounds(roundId);
        assertEq(winningOutcome, 2);
        assertTrue(game.hasUnclaimedBets(roundId, alice));
    }

    function test_singleNumberWins() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 6, 17, 1 ether); // single 17
        _settle(roundId, 17);

        (, , , uint256 winningOutcome,,,,,) = game.rounds(roundId);
        assertEq(winningOutcome, 17);
        assertTrue(game.hasUnclaimedBets(roundId, alice));
    }

    function test_zeroOnlyWinsSingleZero() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 0, 1 ether); // RED loses on 0
        _bet(bob, 6, 0, 1 ether);   // single 0 wins
        _settle(roundId, 37);        // 37 % 37 = 0

        (,,,,,,,, bool hasWinners) = game.rounds(roundId);
        assertTrue(hasWinners);

        // Bob has a winning unclaimed bet.
        assertTrue(game.hasUnclaimedBets(roundId, bob));
        // Alice's outside bet loses; claim should revert.
        vm.prank(alice);
        vm.expectRevert();
        game.claimWinnings(roundId);
    }

    function test_outsideBetsLoseOnZero() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 2, 0, 1 ether); // EVEN
        _settle(roundId, 37);        // 37 % 37 = 0

        (, , , uint256 winningOutcome,,, bool settled,, bool hasWinners) = game.rounds(roundId);
        assertEq(winningOutcome, 0);
        assertTrue(settled);
        assertFalse(hasWinners);
        assertGt(game.jackpot(), 0);
    }

    function test_splitPoolProportional() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 0, 1 ether); // RED
        _bet(bob, 0, 0, 2 ether);   // RED
        _settle(roundId, 3);         // 3 is red

        vm.prank(alice);
        game.claimWinnings(roundId);

        (, uint256 totalPool, uint256 totalWinningBets,, uint256 prizePool,,,,) = game.rounds(roundId);
        assertEq(totalWinningBets, 3 ether);
        assertEq(totalPool, 3 ether);
        uint256 bounty = Math.mulDiv(totalPool, BOUNTY_BPS, 10000);
        assertEq(prizePool, totalPool - bounty); // all bets win, house cut returned
    }

    function test_bettorCountWithMultipleBets() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 0, 0.5 ether);
        _bet(alice, 1, 0, 0.5 ether);
        assertEq(game.roundBettorCount(roundId), 1);
    }

    function test_evenWinsOn32() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 2, 0, 1 ether); // EVEN
        _settle(roundId, 32);       // 32 is even

        (, , , uint256 winningOutcome,,, bool settled,, bool hasWinners) = game.rounds(roundId);
        assertEq(winningOutcome, 32);
        assertTrue(settled);
        assertTrue(hasWinners);
        assertTrue(game.hasUnclaimedBets(roundId, alice));

        vm.prank(alice);
        game.claimWinnings(roundId);
    }

    function test_oddWinsOn3() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 3, 0, 1 ether); // ODD
        _settle(roundId, 3);        // 3 is odd

        assertTrue(game.hasUnclaimedBets(roundId, alice));
        vm.prank(alice);
        game.claimWinnings(roundId);
    }

    function test_highWinsOn32() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 4, 0, 1 ether); // HIGH
        _settle(roundId, 32);       // 32 is in 19-36

        assertTrue(game.hasUnclaimedBets(roundId, alice));
        vm.prank(alice);
        game.claimWinnings(roundId);
    }

    function test_lowWinsOn12() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 5, 0, 1 ether); // LOW
        _settle(roundId, 12);       // 12 is in 1-18

        assertTrue(game.hasUnclaimedBets(roundId, alice));
        vm.prank(alice);
        game.claimWinnings(roundId);
    }

    function test_evenLosesOnOddNumber() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 2, 0, 1 ether); // EVEN
        _settle(roundId, 3);        // 3 is odd

        (, , , uint256 winningOutcome,,, bool settled,, bool hasWinners) = game.rounds(roundId);
        assertEq(winningOutcome, 3);
        assertTrue(settled);
        assertFalse(hasWinners);

        vm.prank(alice);
        vm.expectRevert();
        game.claimWinnings(roundId);
    }
}
