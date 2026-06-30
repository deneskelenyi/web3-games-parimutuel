// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/DiceGame.sol";

contract DiceGameTest is Test {
    DiceGame public game;

    address public alice;
    address public bob;
    address public settler;

    uint256 public constant BLOCKS_PER_ROUND = 5;
    uint256 public constant HOUSE_EDGE_BPS = 500; // 5%
    uint256 public constant BOUNTY_BPS = 10;      // 0.1%

    function setUp() public {
        game = new DiceGame(address(this), BLOCKS_PER_ROUND, HOUSE_EDGE_BPS, BOUNTY_BPS);

        // Lower limits so most tests can settle with a single bettor / small pool
        game.setMinBettors(1);
        game.setMinPool(0);
        game.setMinBet(0.0001 ether);
        game.setClaimExpiryBlocks(0); // disabled for most tests
        game.setCarryOverLimit(3);

        alice = makeAddr("alice");
        bob = makeAddr("bob");
        settler = makeAddr("settler");
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(settler, 1 ether);
    }

    // ─── Helpers ───
    function _bet(address player, uint8 betType, uint256 amount) internal {
        vm.prank(player);
        game.placeBet{value: amount}(betType, 0);
    }

    function _settle(uint256 roundId, uint256 outcome, address caller) internal {
        (uint256 resBlock,,,,,,,,) = game.rounds(roundId);
        // Foundry requires the current block to be >= the target to set its hash.
        vm.roll(resBlock);
        vm.setBlockhash(resBlock, bytes32(outcome));
        vm.roll(resBlock + 1);
        vm.prank(caller);
        game.settleRound(roundId);
    }

    function _goToBettingBlock(uint256 roundId) internal {
        uint256 resBlock = game.resolutionBlockForRound(roundId);
        vm.roll(resBlock - 1);
    }

    function _expectedBounty(uint256 totalPool) internal pure returns (uint256) {
        return Math.mulDiv(totalPool, BOUNTY_BPS, 10000);
    }

    function _expectedHouseCut(uint256 totalPool) internal pure returns (uint256) {
        return Math.mulDiv(totalPool, HOUSE_EDGE_BPS, 10000);
    }

    // ─── Betting tests ───
    function test_placeBet() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 1 ether);

        (, uint256 totalPool,,,,,,,) = game.rounds(roundId);
        assertEq(totalPool, 1 ether);
        assertEq(game.roundBettorCount(roundId), 1);
    }

    function test_getPlayerBets() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 1 ether);
        _bet(alice, 1, 0.5 ether);

        ParimutuelGame.Bet[] memory bets = game.getPlayerBets(roundId, alice);
        assertEq(bets.length, 2);
        assertEq(bets[0].betType, 0);
        assertEq(bets[0].amount, 1 ether);
        assertEq(bets[1].betType, 1);
        assertEq(bets[1].amount, 0.5 ether);
    }

    function test_placeBetBelowMinReverts() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        vm.expectRevert(ParimutuelGame.BelowMinBet.selector);
        _bet(alice, 0, 0.00001 ether);
    }

    function test_bettorCountWithMultipleBets() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 0.5 ether);
        _bet(alice, 0, 0.5 ether);
        assertEq(game.roundBettorCount(roundId), 1);
    }

    // ─── Settlement & claims ───
    function test_settleWinner() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 1 ether); // OVER
        _bet(bob, 1, 1 ether);   // UNDER

        uint256 settlerBalBefore = settler.balance;
        _settle(roundId, 75, settler); // OVER wins

        (,,, uint256 winningOutcome, uint256 prizePool,, bool settled,, bool hasWinners) = game.rounds(roundId);
        assertTrue(settled);
        assertTrue(hasWinners);
        assertEq(winningOutcome, 75);

        uint256 totalPool = 2 ether;
        assertEq(settler.balance - settlerBalBefore, _expectedBounty(totalPool));
        assertEq(prizePool, totalPool - _expectedBounty(totalPool) - _expectedHouseCut(totalPool));

        uint256 aliceBalBefore = alice.balance;
        vm.prank(alice);
        game.claimWinnings(roundId);
        assertEq(alice.balance - aliceBalBefore, prizePool);

        vm.prank(bob);
        vm.expectRevert(ParimutuelGame.NothingToClaim.selector);
        game.claimWinnings(roundId);

        uint256 houseCut = _expectedHouseCut(totalPool);
        assertEq(game.roundHouseCut(roundId), houseCut);
        game.collectHouseCut(roundId);
        assertEq(address(game).balance, 0);
    }

    function test_deadZoneAddsJackpotAndNextRoundUsesIt() public {
        uint256 r0 = game.currentRoundId();
        _goToBettingBlock(r0);
        _bet(alice, 0, 1 ether); // OVER
        _bet(bob, 1, 1 ether);   // UNDER

        _settle(r0, 50, settler); // dead zone

        (,,,,,,,, bool hasWinners) = game.rounds(r0);
        assertFalse(hasWinners);
        uint256 expectedJackpot = 2 ether - _expectedBounty(2 ether) - _expectedHouseCut(2 ether);
        assertEq(game.jackpot(), expectedJackpot);

        // Move to next round
        uint256 r1 = game.currentRoundId();
        _goToBettingBlock(r1);
        _bet(alice, 1, 1 ether); // UNDER

        _settle(r1, 25, settler); // UNDER wins

        (,,,, uint256 prizePool1,,,,) = game.rounds(r1);
        uint256 expectedPrizePool = 1 ether - _expectedBounty(1 ether) - _expectedHouseCut(1 ether) + expectedJackpot;
        assertEq(prizePool1, expectedPrizePool);
        assertEq(game.jackpot(), 0);

        vm.prank(alice);
        game.claimWinnings(r1);
        // Alice lost 1 ETH in r0, bet 1 ETH in r1, and wins the whole prize pool
        assertEq(alice.balance, 100 ether - 1 ether - 1 ether + expectedPrizePool);
    }

    function test_carryOverThenVoid() public {
        game.setMinBettors(2); // require two bettors
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 1 ether);

        // First settle attempt: carry over
        _settle(roundId, 75, settler);
        {
            (uint256 resolutionBlock,,,,, uint256 carryOverCount,, bool voided,) = game.rounds(roundId);
            assertEq(carryOverCount, 1);
            assertEq(resolutionBlock, (roundId + 1) * BLOCKS_PER_ROUND + BLOCKS_PER_ROUND);
            assertFalse(voided);
        }

        // Second settle attempt: carry over again
        _settle(roundId, 75, settler);
        {
            (,,,,, uint256 carryOverCount,,,) = game.rounds(roundId);
            assertEq(carryOverCount, 2);
        }

        // Third attempt: voided after hitting carryOverLimit
        _settle(roundId, 75, settler);
        {
            (,,,,,,, bool voided,) = game.rounds(roundId);
            assertTrue(voided);
        }

        uint256 aliceBalBefore = alice.balance;
        vm.prank(alice);
        game.claimRefund(roundId);
        assertEq(alice.balance - aliceBalBefore, 1 ether);
    }

    function test_voidRefund() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 1 ether);

        // Force void by only having one bettor but requiring two, and carry-over limit of 1
        game.setMinBettors(2);
        game.setCarryOverLimit(1);
        _settle(roundId, 75, settler);

        (,,,,,,, bool voided,) = game.rounds(roundId);
        assertTrue(voided);

        uint256 aliceBalBefore = alice.balance;
        vm.prank(alice);
        game.claimRefund(roundId);
        assertEq(alice.balance - aliceBalBefore, 1 ether);
    }

    function test_withdrawPendingBet() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 1 ether);

        vm.prank(alice);
        game.withdrawPendingBet(roundId);

        assertEq(alice.balance, 100 ether);
        (, uint256 totalPool,,,,,,,) = game.rounds(roundId);
        assertEq(totalPool, 0);
        assertEq(game.roundBettorCount(roundId), 0);
    }

    function test_cannotWithdrawAfterResolution() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 1 ether);
        (uint256 resBlock,,,,,,,,) = game.rounds(roundId);
        vm.roll(resBlock + 1);
        vm.prank(alice);
        vm.expectRevert(ParimutuelGame.BettingClosed.selector);
        game.withdrawPendingBet(roundId);
    }

    function test_floorUsesHouseCut() public {
        // Both bettors bet OVER. The house cut is fully returned so winners
        // are as close to break-even as the bounty allows.
        game.setMinBettors(1);
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 1 ether);
        _bet(bob, 0, 1 ether);

        _settle(roundId, 75, settler);

        uint256 totalPool = 2 ether;
        uint256 bounty = _expectedBounty(totalPool);
        // House cut is fully used for the floor, so only the bounty remains outside the prize pool
        uint256 expectedPrizePool = totalPool - bounty;
        (,,,, uint256 prizePool,,,,) = game.rounds(roundId);
        assertEq(prizePool, expectedPrizePool);
        assertEq(game.roundHouseCut(roundId), 0);

        uint256 payoutPerWinner = expectedPrizePool / 2;
        uint256 aliceBalBefore = alice.balance;
        vm.prank(alice);
        game.claimWinnings(roundId);
        assertEq(alice.balance - aliceBalBefore, payoutPerWinner);
    }

    function test_claimExpiry() public {
        game.setClaimExpiryBlocks(1);
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 1 ether);
        _bet(bob, 1, 1 ether);

        _settle(roundId, 75, settler);

        (uint256 resBlock,,,,,,,,) = game.rounds(roundId);
        // claim is allowed at resBlock + 1, expired one block later
        vm.roll(resBlock + 2);
        vm.prank(alice);
        vm.expectRevert(ParimutuelGame.ClaimExpired.selector);
        game.claimWinnings(roundId);
    }

    function test_cannotDoubleClaim() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        _bet(alice, 0, 1 ether);
        _bet(bob, 1, 1 ether);

        _settle(roundId, 75, settler);

        vm.prank(alice);
        game.claimWinnings(roundId);

        vm.prank(alice);
        vm.expectRevert(ParimutuelGame.NothingToClaim.selector);
        game.claimWinnings(roundId);
    }

    function test_pauseStopsBettingAndSettlement() public {
        uint256 roundId = game.currentRoundId();
        _goToBettingBlock(roundId);
        game.pause();
        vm.expectRevert(abi.encodeWithSelector(Pausable.EnforcedPause.selector));
        _bet(alice, 0, 1 ether);

        // Unpause, bet, then pause before settlement
        game.unpause();
        _bet(alice, 0, 1 ether);
        game.pause();
        (uint256 resBlock,,,,,,,,) = game.rounds(roundId);
        vm.roll(resBlock + 1);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(Pausable.EnforcedPause.selector));
        game.settleRound(roundId);
    }

    receive() external payable {}
}
