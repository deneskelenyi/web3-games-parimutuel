// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PlinkoGame.sol";

contract PlinkoGameTest is Test {
    PlinkoGame public game;

    address public alice;
    address public bob;
    address public settler;

    uint256 public constant BLOCKS_PER_ROUND = 1;
    uint256 public constant HOUSE_EDGE_BPS = 500;
    uint256 public constant BOUNTY_BPS = 10;

    function setUp() public {
        game = new PlinkoGame(address(this), BLOCKS_PER_ROUND, HOUSE_EDGE_BPS, BOUNTY_BPS);
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

    function _bet(address player, uint8 zone, uint256 amount) internal {
        vm.prank(player);
        game.placeBet{value: amount}(0, zone);
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
        _bet(alice, 6, 1 ether);

        (, uint256 totalPool,,,,,,,) = game.rounds(roundId);
        assertEq(totalPool, 1 ether);
        assertEq(game.roundBettorCount(roundId), 1);
    }

    function test_zone0Wins() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 1 ether);
        // value with no bits set in the first 12 positions => zone 0 (but non-zero to avoid fallback)
        _settle(roundId, 1 << 12);

        (, , , uint256 winningOutcome,,,,,) = game.rounds(roundId);
        assertEq(winningOutcome, 0);
        assertTrue(game.hasUnclaimedBets(roundId, alice));
    }

    function test_zone12Wins() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 12, 1 ether);
        // 12 low bits set => zone 12
        _settle(roundId, (1 << 12) - 1);

        (, , , uint256 winningOutcome,,,,,) = game.rounds(roundId);
        assertEq(winningOutcome, 12);
        assertTrue(game.hasUnclaimedBets(roundId, alice));
    }

    function test_zoneMissAddsJackpot() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 6, 1 ether); // zone 6
        _settle(roundId, (1 << 12) - 1); // zone 12

        (, , , uint256 winningOutcome,,, bool settled,, bool hasWinners) = game.rounds(roundId);
        assertEq(winningOutcome, 12);
        assertTrue(settled);
        assertFalse(hasWinners);
        assertGt(game.jackpot(), 0);
    }

    function test_splitPoolProportional() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 6, 1 ether); // zone 6
        _bet(bob, 6, 2 ether);   // zone 6
        _settle(roundId, 63); // 6 bits set in first 12 positions => zone 6

        vm.prank(alice);
        game.claimWinnings(roundId);

        (, uint256 totalPool, uint256 totalWinningBets,, uint256 prizePool,,,,) = game.rounds(roundId);
        assertEq(totalWinningBets, 3 ether);
        assertEq(totalPool, 3 ether);
        // Break-even floor returns house cut because all bets win.
        uint256 bounty = Math.mulDiv(totalPool, BOUNTY_BPS, 10000);
        assertEq(prizePool, totalPool - bounty);
    }

    function test_bettorCountWithMultipleBets() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 5, 0.5 ether);
        _bet(alice, 7, 0.5 ether);
        assertEq(game.roundBettorCount(roundId), 1);
    }
}
