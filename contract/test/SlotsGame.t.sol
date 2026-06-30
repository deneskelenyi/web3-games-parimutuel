// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SlotsGame.sol";

contract SlotsGameTest is Test {
    SlotsGame public game;
    address public alice;
    address public settler;

    uint256 public constant BLOCKS_PER_ROUND = 1;
    uint256 public constant HOUSE_EDGE_BPS = 500;
    uint256 public constant BOUNTY_BPS = 10;

    function setUp() public {
        game = new SlotsGame(address(this), BLOCKS_PER_ROUND, HOUSE_EDGE_BPS, BOUNTY_BPS);
        game.setMinBettors(1);
        game.setMinPool(0);
        game.setMinBet(0.0001 ether);
        game.setClaimExpiryBlocks(0);
        alice = makeAddr("alice");
        settler = makeAddr("settler");
        vm.deal(alice, 100 ether);
        vm.deal(settler, 1 ether);
    }

    function _settle(uint256 roundId, uint256 blockHashValue) internal {
        (uint256 resBlock,,,,,,,,) = game.rounds(roundId);
        if (resBlock == 0) resBlock = game.resolutionBlockForRound(roundId);
        vm.roll(resBlock);
        vm.setBlockhash(resBlock, bytes32(blockHashValue));
        vm.roll(resBlock + 1);
        vm.prank(settler);
        game.settleRound(roundId);
    }

    function test_exactTripleWins() public {
        uint256 roundId = game.currentRoundId();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(0, 0); // exact triple of symbol 0
        _settle(roundId, 512); // rng=512 has first 9 bits zero => all reels 0
        assertTrue(game.hasUnclaimedBets(roundId, alice));
    }

    function test_anyTripleWins() public {
        uint256 roundId = game.currentRoundId();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(1, 0); // any triple
        _settle(roundId, 512); // all reels 0
        assertTrue(game.hasUnclaimedBets(roundId, alice));
    }

    function test_anyPairWins() public {
        uint256 roundId = game.currentRoundId();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(2, 0); // any pair
        _settle(roundId, 1); // rng=1 => s1=1, s2=0, s3=0 (s2==s3 pair)
        assertTrue(game.hasUnclaimedBets(roundId, alice));
    }

    function test_firstSymbolWins() public {
        uint256 roundId = game.currentRoundId();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(3, 1); // first reel == 1
        _settle(roundId, 1); // rng=1 => s1=1
        assertTrue(game.hasUnclaimedBets(roundId, alice));
    }

    function test_firstSymbolLoses() public {
        uint256 roundId = game.currentRoundId();
        vm.roll(game.resolutionBlockForRound(roundId) - 1);
        vm.prank(alice);
        game.placeBet{value: 1 ether}(3, 2); // first reel == 2
        _settle(roundId, 1); // rng=1 => s1=1
        vm.prank(alice);
        vm.expectRevert(ParimutuelGame.NoWinners.selector);
        game.claimWinnings(roundId);
    }
}
