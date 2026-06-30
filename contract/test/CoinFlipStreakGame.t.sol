// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/CoinFlipStreakGame.sol";

contract CoinFlipStreakGameTest is Test {
    CoinFlipStreakGame public game;

    address public alice;
    address public bob;
    address public settler;

    uint256 public constant BLOCKS_PER_ROUND = 1;
    uint256 public constant HOUSE_EDGE_BPS = 500;
    uint256 public constant BOUNTY_BPS = 10;

    function setUp() public {
        game = new CoinFlipStreakGame(address(this), BLOCKS_PER_ROUND, HOUSE_EDGE_BPS, BOUNTY_BPS);
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
        _bet(alice, 1, 1 ether); // streak 1

        (, uint256 totalPool,,,,,,,) = game.rounds(roundId);
        assertEq(totalPool, 1 ether);
        assertEq(game.roundBettorCount(roundId), 1);
    }

    function test_streak0Wins() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 1 ether); // streak 0
        _settle(roundId, 0);      // first bit 0 => streak 0

        (, , , uint256 winningOutcome,,,,,) = game.rounds(roundId);
        assertEq(winningOutcome, 0);
        assertTrue(game.hasUnclaimedBets(roundId, alice));
    }

    function test_streak3Wins() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 3, 1 ether); // streak 3
        // first 3 bits 1, 4th bit 0 => streak 3
        _settle(roundId, 0x07);

        (, , , uint256 winningOutcome,,,,,) = game.rounds(roundId);
        assertEq(winningOutcome, 3);
        assertTrue(game.hasUnclaimedBets(roundId, alice));
    }

    function test_streak6plusWins() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 6, 1 ether); // streak 6+
        // first 8 bits 1 => streak 8
        _settle(roundId, 0x00ff);

        (, , , uint256 winningOutcome,,,,,) = game.rounds(roundId);
        assertEq(winningOutcome, 8);
        assertTrue(game.hasUnclaimedBets(roundId, alice));
    }

    function test_wrongBucketLoses() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 2, 1 ether); // streak 2
        _settle(roundId, 0x02);  // binary 10 = streak 1

        // Alice's bet lost; claiming should revert.
        vm.prank(alice);
        vm.expectRevert();
        game.claimWinnings(roundId);
    }

    function test_splitPoolProportional() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 1, 1 ether); // streak 1
        _bet(bob, 1, 2 ether);   // streak 1
        // bits: 1,0,... => streak 1
        _settle(roundId, 0x01);

        vm.prank(alice);
        game.claimWinnings(roundId);

        (, uint256 totalPool, uint256 totalWinningBets,, uint256 prizePool,,,,) = game.rounds(roundId);
        assertEq(totalWinningBets, 3 ether);
        assertEq(totalPool, 3 ether);
        uint256 bounty = Math.mulDiv(totalPool, BOUNTY_BPS, 10000);
        assertEq(prizePool, totalPool - bounty);
    }

    function test_bettorCountWithMultipleBets() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 0.5 ether);
        _bet(alice, 1, 0.5 ether);
        assertEq(game.roundBettorCount(roundId), 1);
    }
}
