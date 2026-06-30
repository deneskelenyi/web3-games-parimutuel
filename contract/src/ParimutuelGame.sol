// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title ParimutuelGame
 * @notice Abstract base contract for parimutuel blockchain games.
 * @dev All game logic and funds live in the contract. The backend is a thin relay.
 */
abstract contract ParimutuelGame is Ownable, Pausable, ReentrancyGuard {
    // ─── Config ───
    uint256 public blocksPerRound;
    uint256 public houseEdgeBps;
    uint256 public settlementBountyBps;
    uint256 public minPoolWei;
    uint256 public minBettors;
    uint256 public minBetWei;
    uint256 public carryOverLimit;
    uint256 public claimExpiryBlocks;

    // ─── Round State ───
    struct Round {
        uint256 resolutionBlock;
        uint256 totalPool;
        uint256 totalWinningBets;
        uint256 winningOutcome;
        uint256 prizePool;
        uint256 carryOverCount;
        bool settled;
        bool voided;
        bool hasWinners;
    }

    mapping(uint256 => Round) public rounds;

    struct Bet {
        uint8 betType;
        uint256 betValue;
        uint128 amount;
        bool claimed;
    }

    mapping(uint256 => mapping(address => Bet[])) public roundBets;
    mapping(uint256 => uint256) public roundBettorCount;
    mapping(uint256 => address[]) public roundBettors;
    mapping(uint256 => mapping(address => bool)) public isRoundBettor;

    // roundId => accumulated house cut (not yet withdrawn)
    mapping(uint256 => uint256) public roundHouseCut;

    // Jackpot accumulated from no-winner rounds
    uint256 public jackpot;

    // ─── Events ───
    event BetPlaced(
        uint256 indexed roundId,
        address indexed player,
        uint8 betType,
        uint256 betValue,
        uint128 amount
    );
    event RoundSettled(
        uint256 indexed roundId,
        uint256 winningOutcome,
        uint256 totalPool,
        uint256 prizePool
    );
    event RoundVoided(uint256 indexed roundId);
    event RoundCarriedOver(uint256 indexed roundId, uint256 newResolutionBlock);
    event WinningsClaimed(
        uint256 indexed roundId,
        address indexed player,
        uint256 amount
    );
    event RefundClaimed(
        uint256 indexed roundId,
        address indexed player,
        uint256 amount
    );
    event HouseCutCollected(uint256 indexed roundId, uint256 amount);
    event JackpotUpdated(uint256 newJackpot);

    // ─── Errors ───
    error BelowMinBet();
    error BettingClosed();
    error RoundNotReady();
    error AlreadySettled();
    error NoWinners();
    error NothingToClaim();
    error ClaimExpired();
    error TransferFailed();
    error InvalidBps();

    constructor(
        address house,
        uint256 blocksPerRound_,
        uint256 houseEdgeBps_,
        uint256 settlementBountyBps_
    ) Ownable(house) {
        if (blocksPerRound_ == 0) revert("invalid blocksPerRound");
        if (houseEdgeBps_ + settlementBountyBps_ > 10000) revert InvalidBps();

        blocksPerRound = blocksPerRound_;
        houseEdgeBps = houseEdgeBps_;
        settlementBountyBps = settlementBountyBps_;

        // HANDOVER.md defaults
        minPoolWei = 0.001 ether;
        minBettors = 2;
        minBetWei = 0.0001 ether;
        carryOverLimit = 3;
        claimExpiryBlocks = 216000; // ~30 days at 12s blocks
    }

    // ─── Round Derivation ───
    function currentRoundId() public view returns (uint256) {
        return block.number / blocksPerRound;
    }

    function resolutionBlockForRound(uint256 roundId) public view returns (uint256) {
        return (roundId + 1) * blocksPerRound;
    }

    // ─── Betting ───
    function placeBet(
        uint8 betType,
        uint256 betValue
    ) external payable nonReentrant whenNotPaused {
        if (msg.value < minBetWei) revert BelowMinBet();

        uint256 roundId = currentRoundId();
        Round storage r = rounds[roundId];
        if (r.resolutionBlock == 0) {
            r.resolutionBlock = resolutionBlockForRound(roundId);
        }
        if (block.number >= r.resolutionBlock) revert BettingClosed();

        if (!isRoundBettor[roundId][msg.sender]) {
            isRoundBettor[roundId][msg.sender] = true;
            roundBettors[roundId].push(msg.sender);
            roundBettorCount[roundId]++;
        }

        roundBets[roundId][msg.sender].push(
            Bet({
                betType: betType,
                betValue: betValue,
                amount: uint128(msg.value),
                claimed: false
            })
        );
        r.totalPool += msg.value;

        emit BetPlaced(roundId, msg.sender, betType, betValue, uint128(msg.value));
    }

    // ─── Settlement ───
    function settleRound(uint256 roundId) external virtual nonReentrant whenNotPaused {
        Round storage r = rounds[roundId];
        if (r.settled || r.voided) revert AlreadySettled();
        if (r.resolutionBlock == 0) {
            r.resolutionBlock = resolutionBlockForRound(roundId);
        }
        if (block.number <= r.resolutionBlock) revert RoundNotReady();

        // No bets → void immediately
        if (r.totalPool == 0) {
            r.voided = true;
            emit RoundVoided(roundId);
            return;
        }

        // Minimums not met → carry over or void
        if (r.totalPool < minPoolWei || roundBettorCount[roundId] < minBettors) {
            r.carryOverCount++;
            if (r.carryOverCount >= carryOverLimit) {
                r.voided = true;
                emit RoundVoided(roundId);
            } else {
                r.resolutionBlock += blocksPerRound;
                emit RoundCarriedOver(roundId, r.resolutionBlock);
            }
            return;
        }

        uint256 winningOutcome = _determineOutcome(roundId);
        (uint256 totalWinningBets, bool hasWinners) = _calculateWinners(
            roundId,
            winningOutcome
        );

        uint256 bounty = Math.mulDiv(r.totalPool, settlementBountyBps, 10000);
        uint256 houseCut = Math.mulDiv(r.totalPool, houseEdgeBps, 10000);
        uint256 prizePool = r.totalPool - bounty - houseCut + jackpot;

        // Break-even floor: winners must get at least their proportional share.
        // Any shortfall is taken from the house cut first.
        if (hasWinners && prizePool < totalWinningBets) {
            uint256 shortfall = totalWinningBets - prizePool;
            if (shortfall <= houseCut) {
                houseCut -= shortfall;
                prizePool += shortfall;
            } else {
                houseCut = 0;
                prizePool = r.totalPool - bounty;
            }
        }

        r.winningOutcome = winningOutcome;
        r.totalWinningBets = totalWinningBets;
        r.settled = true;
        r.hasWinners = hasWinners;
        roundHouseCut[roundId] = houseCut;

        if (!hasWinners) {
            jackpot += prizePool;
            r.prizePool = 0;
            emit JackpotUpdated(jackpot);
        } else {
            if (jackpot > 0) {
                jackpot = 0;
            }
            r.prizePool = prizePool;
        }

        // Pay settlement bounty to the caller
        if (bounty > 0) {
            (bool s, ) = payable(msg.sender).call{value: bounty}("");
            if (!s) revert TransferFailed();
        }

        emit RoundSettled(roundId, winningOutcome, r.totalPool, r.prizePool);
    }

    // ─── Claims ───
    function claimWinnings(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (!r.settled || !r.hasWinners) revert NoWinners();
        if (claimExpiryBlocks > 0 && block.number > r.resolutionBlock + claimExpiryBlocks) {
            revert ClaimExpired();
        }

        uint256 payout = 0;
        Bet[] storage bets = roundBets[roundId][msg.sender];
        for (uint256 i = 0; i < bets.length; i++) {
            if (!bets[i].claimed && _isWinningBet(bets[i], r.winningOutcome, msg.sender, roundId)) {
                bets[i].claimed = true;
                payout += Math.mulDiv(bets[i].amount, r.prizePool, r.totalWinningBets);
            }
        }

        if (payout == 0) revert NothingToClaim();

        (bool s, ) = payable(msg.sender).call{value: payout}("");
        if (!s) revert TransferFailed();

        emit WinningsClaimed(roundId, msg.sender, payout);
    }

    // ─── Refunds (voided rounds) ───
    function claimRefund(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (!r.voided) revert("not voided");

        uint256 refund = 0;
        Bet[] storage bets = roundBets[roundId][msg.sender];
        for (uint256 i = 0; i < bets.length; i++) {
            if (!bets[i].claimed) {
                bets[i].claimed = true;
                refund += bets[i].amount;
            }
        }

        if (refund == 0) revert NothingToClaim();

        (bool s, ) = payable(msg.sender).call{value: refund}("");
        if (!s) revert TransferFailed();

        emit RefundClaimed(roundId, msg.sender, refund);
    }

    // ─── Withdraw pending bet before settlement ───
    function withdrawPendingBet(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.settled || r.voided) revert("round closed");
        if (r.resolutionBlock != 0 && block.number >= r.resolutionBlock) {
            revert BettingClosed();
        }

        Bet[] storage bets = roundBets[roundId][msg.sender];
        if (bets.length == 0) revert NothingToClaim();

        uint256 refund = 0;
        uint256 unclaimedRemaining = 0;
        for (uint256 i = 0; i < bets.length; i++) {
            if (!bets[i].claimed) {
                bets[i].claimed = true;
                refund += bets[i].amount;
            } else {
                unclaimedRemaining++;
            }
        }

        if (refund == 0) revert NothingToClaim();

        r.totalPool -= refund;

        // If the player no longer has any live bets, remove them from the active bettor count
        if (unclaimedRemaining == 0 && roundBettorCount[roundId] > 0) {
            roundBettorCount[roundId]--;
            isRoundBettor[roundId][msg.sender] = false;
        }

        (bool s, ) = payable(msg.sender).call{value: refund}("");
        if (!s) revert TransferFailed();
    }

    // ─── House functions ───
    function collectHouseCut(uint256 roundId) external onlyOwner nonReentrant {
        uint256 amount = roundHouseCut[roundId];
        if (amount == 0) revert NothingToClaim();
        roundHouseCut[roundId] = 0;

        (bool s, ) = payable(owner()).call{value: amount}("");
        if (!s) revert TransferFailed();

        emit HouseCutCollected(roundId, amount);
    }

    function setHouseEdge(uint256 bps) external onlyOwner {
        if (bps + settlementBountyBps > 10000) revert InvalidBps();
        houseEdgeBps = bps;
    }

    function setSettlementBounty(uint256 bps) external onlyOwner {
        if (houseEdgeBps + bps > 10000) revert InvalidBps();
        settlementBountyBps = bps;
    }

    function setMinPool(uint256 wei_) external onlyOwner {
        minPoolWei = wei_;
    }

    function setMinBettors(uint256 n) external onlyOwner {
        minBettors = n;
    }

    function setMinBet(uint256 wei_) external onlyOwner {
        minBetWei = wei_;
    }

    function setCarryOverLimit(uint256 n) external onlyOwner {
        carryOverLimit = n;
    }

    function setClaimExpiryBlocks(uint256 n) external onlyOwner {
        claimExpiryBlocks = n;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Helpers ───
    function hasUnclaimedBets(uint256 roundId, address player) public view returns (bool) {
        Bet[] storage bets = roundBets[roundId][player];
        for (uint256 i = 0; i < bets.length; i++) {
            if (!bets[i].claimed) return true;
        }
        return false;
    }

    function getPlayerBets(uint256 roundId, address player) public view returns (Bet[] memory) {
        return roundBets[roundId][player];
    }

    function _getRNG(uint256 roundId) internal view returns (uint256) {
        uint256 resBlock = rounds[roundId].resolutionBlock;
        uint256 rng = uint256(blockhash(resBlock));
        if (rng != 0) return rng;

        // Fallback deterministic RNG if the resolution blockhash is unavailable.
        bytes32 fallbackHash = blockhash(block.number - 1);
        if (fallbackHash != 0) return uint256(fallbackHash);

        return uint256(
            keccak256(
                abi.encodePacked(roundId, block.number, block.timestamp)
            )
        );
    }

    function _calculateWinners(
        uint256 roundId,
        uint256 winningOutcome
    ) internal view virtual returns (uint256 totalWinningBets, bool hasWinners) {
        address[] storage bettors = roundBettors[roundId];
        for (uint256 i = 0; i < bettors.length; i++) {
            address player = bettors[i];
            Bet[] storage bets = roundBets[roundId][player];
            for (uint256 j = 0; j < bets.length; j++) {
                if (!bets[j].claimed && _isWinningBet(bets[j], winningOutcome, player, roundId)) {
                    totalWinningBets += bets[j].amount;
                    hasWinners = true;
                }
            }
        }
    }

    // ─── Abstract hooks ───
    function _determineOutcome(uint256 roundId) internal view virtual returns (uint256);

    function _isWinningBet(
        Bet memory bet,
        uint256 winningOutcome,
        address player,
        uint256 roundId
    ) internal view virtual returns (bool);

    receive() external payable {}
    fallback() external payable {}
}
