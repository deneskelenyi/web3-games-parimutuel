// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ColorDuelGame.sol";

contract ColorDuelTest is Test {
    ColorDuelGame public game;

    address public alice;
    address public bob;
    address public settler;

    uint256 public constant BLOCKS_PER_ROUND = 1;
    uint256 public constant HOUSE_EDGE_BPS = 500;
    uint256 public constant BOUNTY_BPS = 10;

    function setUp() public {
        game = new ColorDuelGame(address(this), BLOCKS_PER_ROUND, HOUSE_EDGE_BPS, BOUNTY_BPS);
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
        _bet(alice, 0, 1 ether);

        (, uint256 totalPool,,,,,,,) = game.rounds(roundId);
        assertEq(totalPool, 1 ether);
        assertEq(game.roundBettorCount(roundId), 1);
    }

    function test_redWins() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 1 ether);
        _settle(roundId, 0);

        (, , , uint256 winningOutcome,,,,,) = game.rounds(roundId);
        assertEq(winningOutcome, 0);
        assertTrue(game.hasUnclaimedBets(roundId, alice));
    }

    function test_splitPoolProportional() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 1 ether); // RED
        _bet(bob, 1, 2 ether);   // GREEN
        _settle(roundId, 0);     // RED wins

        vm.prank(alice);
        game.claimWinnings(roundId);

        (, uint256 totalPool, uint256 totalWinningBets,, uint256 prizePool,,,,) = game.rounds(roundId);
        assertEq(totalWinningBets, 1 ether);
        assertEq(totalPool, 3 ether);
        assertEq(prizePool, totalPool - Math.mulDiv(totalPool, HOUSE_EDGE_BPS, 10000) - Math.mulDiv(totalPool, BOUNTY_BPS, 10000));
    }

    function test_greenWins() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 1, 1 ether);
        _settle(roundId, 1);

        (, , , uint256 winningOutcome,,,,,) = game.rounds(roundId);
        assertEq(winningOutcome, 1);
    }

    function test_blueWins() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 2, 1 ether);
        _settle(roundId, 2);

        (, , , uint256 winningOutcome,,,,,) = game.rounds(roundId);
        assertEq(winningOutcome, 2);
    }

    function test_noWinnerRollsToJackpot() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 1 ether); // RED
        _settle(roundId, 1);     // GREEN wins, no RED winner

        (, , , uint256 winningOutcome,,,,,) = game.rounds(roundId);
        assertEq(winningOutcome, 1);
        assertGt(game.jackpot(), 0); // Entire prize pool rolled into jackpot
    }

    function test_bettorCountWithMultipleBets() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 0.5 ether);
        _bet(alice, 1, 0.5 ether);
        assertEq(game.roundBettorCount(roundId), 1);
    }
}
