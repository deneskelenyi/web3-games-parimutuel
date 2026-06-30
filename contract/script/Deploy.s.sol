// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/DiceGame.sol";
import "../src/ColorDuelGame.sol";
import "../src/CrashGame.sol";
import "../src/PlinkoGame.sol";
import "../src/RouletteGame.sol";
import "../src/CoinFlipStreakGame.sol";
import "../src/SlotsGame.sol";
import "../src/HorseRaceGame.sol";
import "../src/KenoGame.sol";
import "../src/BlockBingoGame.sol";
import "../src/MinefieldGame.sol";

contract Deploy is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address house = vm.envOr("HOUSE_ADDRESS", vm.addr(deployerPrivateKey));
        uint256 blocksPerRound = vm.envOr("BLOCKS_PER_ROUND", uint256(5));
        uint256 houseEdgeBps = vm.envOr("HOUSE_EDGE_BPS", uint256(500));
        uint256 settlementBountyBps = vm.envOr("SETTLEMENT_BOUNTY_BPS", uint256(10));

        // Fast games use 1-block rounds for snappy demos.
        uint256 colorDuelBlocks = vm.envOr("COLOR_DUEL_BLOCKS_PER_ROUND", uint256(1));
        uint256 crashBlocks = vm.envOr("CRASH_BLOCKS_PER_ROUND", uint256(1));
        uint256 plinkoBlocks = vm.envOr("PLINKO_BLOCKS_PER_ROUND", uint256(1));
        uint256 rouletteBlocks = vm.envOr("ROULETTE_BLOCKS_PER_ROUND", uint256(1));
        uint256 coinFlipBlocks = vm.envOr("COIN_FLIP_BLOCKS_PER_ROUND", uint256(1));
        uint256 slotsBlocks = vm.envOr("SLOTS_BLOCKS_PER_ROUND", uint256(1));
        uint256 horseRaceBlocks = vm.envOr("HORSE_RACE_BLOCKS_PER_ROUND", uint256(3));
        uint256 kenoBlocks = vm.envOr("KENO_BLOCKS_PER_ROUND", uint256(1));
        uint256 bingoBlocks = vm.envOr("BINGO_BLOCKS_PER_ROUND", uint256(5));
        uint256 minefieldBlocks = vm.envOr("MINEFIELD_BLOCKS_PER_ROUND", uint256(1));

        vm.startBroadcast(deployerPrivateKey);

        DiceGame dice = new DiceGame(house, blocksPerRound, houseEdgeBps, settlementBountyBps);
        ColorDuelGame colorDuel = new ColorDuelGame(house, colorDuelBlocks, houseEdgeBps, settlementBountyBps);
        CrashGame crash = new CrashGame(house, crashBlocks, houseEdgeBps, settlementBountyBps);
        PlinkoGame plinko = new PlinkoGame(house, plinkoBlocks, houseEdgeBps, settlementBountyBps);
        RouletteGame roulette = new RouletteGame(house, rouletteBlocks, houseEdgeBps, settlementBountyBps);
        CoinFlipStreakGame coinFlip = new CoinFlipStreakGame(house, coinFlipBlocks, houseEdgeBps, settlementBountyBps);
        SlotsGame slots = new SlotsGame(house, slotsBlocks, houseEdgeBps, settlementBountyBps);
        HorseRaceGame horseRace = new HorseRaceGame(house, horseRaceBlocks, houseEdgeBps, settlementBountyBps);
        KenoGame keno = new KenoGame(house, kenoBlocks, houseEdgeBps, settlementBountyBps);
        BlockBingoGame bingo = new BlockBingoGame(house, bingoBlocks, houseEdgeBps, settlementBountyBps);
        MinefieldGame minefield = new MinefieldGame(house, minefieldBlocks, houseEdgeBps, settlementBountyBps);

        vm.stopBroadcast();

        console.log("DiceGame deployed at:", address(dice));
        console.log("ColorDuelGame deployed at:", address(colorDuel));
        console.log("CrashGame deployed at:", address(crash));
        console.log("PlinkoGame deployed at:", address(plinko));
        console.log("RouletteGame deployed at:", address(roulette));
        console.log("CoinFlipStreakGame deployed at:", address(coinFlip));
        console.log("SlotsGame deployed at:", address(slots));
        console.log("HorseRaceGame deployed at:", address(horseRace));
        console.log("KenoGame deployed at:", address(keno));
        console.log("BlockBingoGame deployed at:", address(bingo));
        console.log("MinefieldGame deployed at:", address(minefield));
        console.log("House:", house);
        console.log("Blocks per round:", blocksPerRound);
        console.log("Color Duel blocks per round:", colorDuelBlocks);
        console.log("Crash blocks per round:", crashBlocks);
        console.log("Plinko blocks per round:", plinkoBlocks);
        console.log("Roulette blocks per round:", rouletteBlocks);
        console.log("Coin Flip blocks per round:", coinFlipBlocks);
        console.log("Slots blocks per round:", slotsBlocks);
        console.log("Horse Race blocks per round:", horseRaceBlocks);
        console.log("Keno blocks per round:", kenoBlocks);
        console.log("Bingo blocks per round:", bingoBlocks);
        console.log("Minefield blocks per round:", minefieldBlocks);
        console.log("House edge bps:", houseEdgeBps);
        console.log("Settlement bounty bps:", settlementBountyBps);
    }
}
