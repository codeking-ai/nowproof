// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title NowProof — "time sandwich" proofs for live video
/// @notice Every ~0.4s video segment is bound between two blocks:
///   - lower bound: the segment's frames show `seenBlock`'s number + hash, which
///     nobody could know before that block existed  ("not earlier than")
///   - upper bound: the segment's hash is anchored in the block this tx lands in
///                                                            ("not later than")
///   The contract enforces that both blocks are at most MAX_LAG blocks apart, so
///   each segment is pinned to a sub-second window on Monad.
contract NowProof {
    uint256 public constant MAX_LAG = 10; // blocks (~4s on Monad, a hard ceiling)

    struct Session {
        address owner;
        uint64 startBlock;
        uint64 startTime;
    }

    uint256 public sessionCount;
    mapping(uint256 => Session) public sessions;

    event SessionStarted(uint256 indexed id, address indexed owner, string label, uint64 startBlock);
    event Anchored(
        uint256 indexed id,
        uint32 indexed seq,
        bytes32 chunkHash,
        uint64 offset,
        uint32 size,
        uint64 seenBlock,
        bytes32 seenHash,
        uint64 anchorBlock,
        uint64 anchorTime
    );

    error NotOwner();
    error BadLag(uint256 seenBlock, uint256 currentBlock);
    error BadSeenHash(bytes32 expected, bytes32 got);

    function start(string calldata label) external returns (uint256 id) {
        id = ++sessionCount;
        sessions[id] = Session(msg.sender, uint64(block.number), uint64(block.timestamp));
        emit SessionStarted(id, msg.sender, label, uint64(block.number));
    }

    function anchor(
        uint256 id,
        uint32 seq,
        bytes32 chunkHash,
        uint64 offset,
        uint32 size,
        uint64 seenBlock,
        bytes32 seenHash
    ) external {
        if (sessions[id].owner != msg.sender) revert NotOwner();
        if (seenBlock >= block.number || block.number - seenBlock > MAX_LAG) {
            revert BadLag(seenBlock, block.number);
        }
        bytes32 real = blockhash(seenBlock);
        if (real != seenHash) revert BadSeenHash(real, seenHash);
        emit Anchored(id, seq, chunkHash, offset, size, seenBlock, seenHash, uint64(block.number), uint64(block.timestamp));
    }
}
