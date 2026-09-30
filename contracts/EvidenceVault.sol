// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

interface IEvidenceAuthorization {
    function canSubmitEvidence(uint256 disputeId, address submitter) external view returns (bool);
}

contract EvidenceVault is Ownable {
    struct Evidence {
        uint256 disputeId;
        address submitter;
        string ipfsCID;
        bytes32 evidenceHash;
        uint256 timestamp;
    }
    address public resolution;
    mapping(uint256 => Evidence[]) public disputeEvidences;
    mapping(bytes32 => bool) public isEvidenceSubmitted;
    event ResolutionConfigured(address indexed resolution);
    event EvidenceSubmitted(uint256 indexed disputeId, address indexed submitter, string ipfsCID);

    constructor() Ownable(msg.sender) {}

    // Bind once, after deploying DisputeResolution. Existing provenance cannot be rerouted.
    function setResolution(address resolver) external onlyOwner {
        require(resolution == address(0), "Resolution already configured");
        require(resolver.code.length > 0, "Invalid resolution");
        resolution = resolver;
        emit ResolutionConfigured(resolver);
    }

    function submitEvidence(uint256 disputeId, string calldata cid, bytes32 hash) external {
        _submit(disputeId, msg.sender, cid, hash);
    }

    function submitEvidenceFor(uint256 disputeId, address submitter, string calldata cid, bytes32 hash) external {
        require(msg.sender == resolution, "Only resolution");
        _submit(disputeId, submitter, cid, hash);
    }

    function _submit(uint256 disputeId, address submitter, string calldata cid, bytes32 hash) internal {
        require(resolution != address(0), "Resolution not configured");
        require(IEvidenceAuthorization(resolution).canSubmitEvidence(disputeId, submitter), "Evidence not authorized");
        require(bytes(cid).length > 0 && hash != bytes32(0), "Invalid evidence");
        bytes32 key = keccak256(abi.encode(disputeId, submitter, cid, hash));
        require(!isEvidenceSubmitted[key], "Evidence already submitted");
        isEvidenceSubmitted[key] = true;
        disputeEvidences[disputeId].push(Evidence(disputeId, submitter, cid, hash, block.timestamp));
        emit EvidenceSubmitted(disputeId, submitter, cid);
    }

    // Hash equality checks anchored metadata; it does not authenticate the underlying facts.
    function verifyEvidence(uint256 disputeId, uint256 index, bytes32 computedHash) external view returns (bool) {
        require(index < disputeEvidences[disputeId].length, "Invalid index");
        return disputeEvidences[disputeId][index].evidenceHash == computedHash;
    }
    function getEvidenceCount(uint256 disputeId) external view returns (uint256) { return disputeEvidences[disputeId].length; }
    function getEvidence(uint256 disputeId, uint256 index) external view returns (Evidence memory) { return disputeEvidences[disputeId][index]; }
}
