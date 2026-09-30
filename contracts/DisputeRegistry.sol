// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract DisputeRegistry is AccessControl, ReentrancyGuard {
    bytes32 public constant EXPERT_ROLE = keccak256("EXPERT_ROLE");
    bytes32 public constant RESOLUTION_ROLE = keccak256("RESOLUTION_ROLE");
    uint256 public constant ARBITRATOR_STAKE = 1 ether;
    uint256 public constant EXPERT_STAKE = 2 ether;

    struct ArbitratorProfile {
        bool isRegistered;
        uint256 stakedAmount;
        uint256 activeDisputes;
        uint256 correctVotes;
        uint256 wrongVotes;
    }
    mapping(address => ArbitratorProfile) public arbitrators;
    address[] public registeredArbitrators;
    mapping(address => ArbitratorProfile) public experts;
    address[] public registeredExperts;
    mapping(address => uint256) private arbitratorIndex;
    mapping(address => uint256) private expertIndex;
    uint256 public slashedFunds;

    event ArbitratorRegistered(address indexed arbitrator, uint256 amount);
    event ExpertRegistered(address indexed expert, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event Slashed(address indexed user, uint256 amount);
    event Rewarded(address indexed user, uint256 amount);
    event StakeToppedUp(address indexed user, uint256 amount);
    event SlashedFundsWithdrawn(address indexed recipient, uint256 amount);

    constructor() { _grantRole(DEFAULT_ADMIN_ROLE, msg.sender); }

    function registerArbitrator() external payable nonReentrant {
        require(msg.value == ARBITRATOR_STAKE, "Incorrect stake");
        require(!arbitrators[msg.sender].isRegistered && !experts[msg.sender].isRegistered, "Already registered");
        arbitrators[msg.sender] = ArbitratorProfile(true, msg.value, 0, 0, 0);
        registeredArbitrators.push(msg.sender);
        arbitratorIndex[msg.sender] = registeredArbitrators.length;
        emit ArbitratorRegistered(msg.sender, msg.value);
    }

    function registerExpert() external payable nonReentrant {
        require(msg.value == EXPERT_STAKE, "Incorrect stake");
        require(!experts[msg.sender].isRegistered && !arbitrators[msg.sender].isRegistered, "Already registered");
        experts[msg.sender] = ArbitratorProfile(true, msg.value, 0, 0, 0);
        registeredExperts.push(msg.sender);
        expertIndex[msg.sender] = registeredExperts.length;
        _grantRole(EXPERT_ROLE, msg.sender);
        emit ExpertRegistered(msg.sender, msg.value);
    }

    function _profile(address user) internal view returns (ArbitratorProfile storage) {
        if (arbitrators[user].isRegistered) return arbitrators[user];
        require(experts[user].isRegistered, "Not registered");
        return experts[user];
    }

    function topUpStake() external payable nonReentrant {
        ArbitratorProfile storage p = _profile(msg.sender);
        uint256 required = arbitrators[msg.sender].isRegistered ? ARBITRATOR_STAKE : EXPERT_STAKE;
        require(msg.value > 0 && p.stakedAmount + msg.value <= required, "Invalid top-up");
        p.stakedAmount += msg.value;
        emit StakeToppedUp(msg.sender, msg.value);
    }

    function _remove(address user, address[] storage pool, mapping(address => uint256) storage indices) internal {
        uint256 index = indices[user] - 1;
        address last = pool[pool.length - 1];
        pool[index] = last;
        indices[last] = index + 1;
        pool.pop();
        delete indices[user];
    }

    function unstake() external nonReentrant {
        ArbitratorProfile storage p = _profile(msg.sender);
        require(p.activeDisputes == 0, "Active disputes");
        uint256 amount = p.stakedAmount;
        if (arbitrators[msg.sender].isRegistered) {
            _remove(msg.sender, registeredArbitrators, arbitratorIndex);
        } else {
            _remove(msg.sender, registeredExperts, expertIndex);
            _revokeRole(EXPERT_ROLE, msg.sender);
        }
        p.isRegistered = false;
        p.stakedAmount = 0;
        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "Stake transfer failed");
        emit Unstaked(msg.sender, amount);
    }

    function lockArbitrator(address user) external onlyRole(RESOLUTION_ROLE) {
        ArbitratorProfile storage p = _profile(user);
        uint256 required = arbitrators[user].isRegistered ? ARBITRATOR_STAKE : EXPERT_STAKE;
        require(p.stakedAmount >= required, "Insufficient stake");
        p.activeDisputes++;
    }

    function releaseArbitrator(address user) external onlyRole(RESOLUTION_ROLE) {
        ArbitratorProfile storage p = _profile(user);
        require(p.activeDisputes > 0, "No active dispute");
        p.activeDisputes--;
    }

    function slash(address user, uint256 amount) external onlyRole(RESOLUTION_ROLE) nonReentrant {
        ArbitratorProfile storage p = _profile(user);
        uint256 actual = p.stakedAmount < amount ? p.stakedAmount : amount;
        p.stakedAmount -= actual;
        p.wrongVotes++;
        slashedFunds += actual;
        emit Slashed(user, actual);
    }

    // Record majority coherence only. No monetary reward is promised or minted.
    function reward(address user, uint256 amount) external onlyRole(RESOLUTION_ROLE) {
        require(amount == 0, "Monetary rewards unsupported");
        _profile(user).correctVotes++;
        emit Rewarded(user, 0);
    }

    function withdrawSlashedFunds(address payable recipient, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        require(recipient != address(0) && amount <= slashedFunds, "Invalid withdrawal");
        slashedFunds -= amount;
        (bool sent, ) = recipient.call{value: amount}("");
        require(sent, "Slash transfer failed");
        emit SlashedFundsWithdrawn(recipient, amount);
    }

    function _select(uint256 seed, uint256 count, bool expert, address[] memory excluded) internal view returns (address[] memory) {
        require(count > 0, "Empty panel");
        address[] storage pool = expert ? registeredExperts : registeredArbitrators;
        address[] memory eligible = new address[](pool.length);
        uint256 size;
        for (uint256 i; i < pool.length; i++) {
            address user = pool[i];
            ArbitratorProfile storage p = expert ? experts[user] : arbitrators[user];
            bool allowed = p.isRegistered && p.stakedAmount >= (expert ? EXPERT_STAKE : ARBITRATOR_STAKE);
            for (uint256 j; j < excluded.length; j++) if (user == excluded[j]) allowed = false;
            if (allowed) eligible[size++] = user;
        }
        require(size >= count, expert ? "Not enough experts" : "Not enough arbitrators");
        address[] memory panel = new address[](count);
        // Deterministic prototype selection. This is NOT adversary-resistant randomness.
        uint256 start = seed % size;
        for (uint256 i; i < count; i++) panel[i] = eligible[(start + i) % size];
        return panel;
    }

    function selectJury(uint256 seed, uint256 count) external view returns (address[] memory) {
        return _select(seed, count, false, new address[](0));
    }
    function selectExpertPanel(uint256 seed, uint256 count) external view returns (address[] memory) {
        return _select(seed, count, true, new address[](0));
    }
    function selectJuryExcluding(uint256 seed, uint256 count, address[] calldata excluded) external view returns (address[] memory) {
        return _select(seed, count, false, excluded);
    }
    function selectExpertPanelExcluding(uint256 seed, uint256 count, address[] calldata excluded) external view returns (address[] memory) {
        return _select(seed, count, true, excluded);
    }
}
