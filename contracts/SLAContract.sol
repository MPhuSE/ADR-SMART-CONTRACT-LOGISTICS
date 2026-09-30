// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

contract SLAContract is AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    enum DisputeType {
        LateDelivery,
        Shortage,
        Damage,
        DeliveryDenial,
        PaymentDelay
    }

    enum Operator {
        GreaterThan,
        LessThan,
        Equal,
        NotEqual
    }

    // Three-state evaluation result. NotEvaluable distinguishes "no measurement
    // has been written yet" from a genuine "measured value shows no breach".
    enum EvalStatus {
        NotEvaluable,
        NoBreach,
        Breach
    }

    struct Clause {
        DisputeType disputeType;
        Operator operator;
        uint256 threshold;
        uint256 penaltyBps; // 10000 = 100%
    }

    struct SLA {
        address buyer;
        address seller;
        uint256 escrowValue;
        bool isActive;
        mapping(uint256 => Clause) clauses;
        uint256 clauseCount;
    }

    mapping(uint256 => SLA) public slas;
    uint256 public slaCounter;

    // slaId => clauseId => measuredValue
    mapping(uint256 => mapping(uint256 => uint256)) public measuredValues;
    mapping(uint256 => mapping(uint256 => bool)) public valueMeasured;

    mapping(uint256 => mapping(uint256 => uint256)) public measurementVersions;
    mapping(uint256 => mapping(uint256 => uint256)) public measurementTimestamps;

    event SLACreated(uint256 indexed slaId, address indexed buyer, address indexed seller, uint256 escrowValue);
    event ClauseAdded(uint256 indexed slaId, uint256 indexed clauseId, DisputeType disputeType);
    event ValueUpdated(uint256 indexed slaId, uint256 indexed clauseId, uint256 measuredValue);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        _grantRole(ORACLE_ROLE, msg.sender);
    }

    function createSLA(
        address _buyer,
        address _seller,
        uint256 _escrowValue,
        Clause[] memory _clauses
    ) external onlyRole(ADMIN_ROLE) returns (uint256) {
        require(_buyer != address(0) && _seller != address(0) && _buyer != _seller, "Invalid parties");
        require(_clauses.length > 0, "No clauses");
        uint256 slaId = ++slaCounter;
        SLA storage newSLA = slas[slaId];
        newSLA.buyer = _buyer;
        newSLA.seller = _seller;
        newSLA.escrowValue = _escrowValue;
        newSLA.isActive = true;

        for (uint256 i = 0; i < _clauses.length; i++) {
            require(_clauses[i].penaltyBps <= 10000, "Invalid penalty");
            newSLA.clauses[i] = _clauses[i];
            emit ClauseAdded(slaId, i, _clauses[i].disputeType);
        }
        newSLA.clauseCount = _clauses.length;

        emit SLACreated(slaId, _buyer, _seller, _escrowValue);
        return slaId;
    }

    function updateMeasuredValue(uint256 _slaId, uint256 _clauseId, uint256 _measuredValue) external onlyRole(ORACLE_ROLE) {
        require(slas[_slaId].isActive, "SLA not active");
        require(_clauseId < slas[_slaId].clauseCount, "Invalid clauseId");

        measuredValues[_slaId][_clauseId] = _measuredValue;
        valueMeasured[_slaId][_clauseId] = true;
        measurementVersions[_slaId][_clauseId]++;
        measurementTimestamps[_slaId][_clauseId] = block.timestamp;

        emit ValueUpdated(_slaId, _clauseId, _measuredValue);
    }

    function evaluateClause(uint256 _slaId, uint256 _clauseId) external view returns (EvalStatus status, uint256 penaltyAmount) {
        require(slas[_slaId].isActive, "SLA not active");
        require(_clauseId < slas[_slaId].clauseCount, "Invalid clauseId");

        // Distinguish "not measured yet" from "measured, no breach". A clause
        // with no oracle measurement is NotEvaluable and must not silently
        // resolve to NoBreach (which would favour the breaching party).
        if (!valueMeasured[_slaId][_clauseId]) {
            return (EvalStatus.NotEvaluable, 0);
        }

        SLA storage sla = slas[_slaId];
        Clause storage clause = sla.clauses[_clauseId];
        uint256 measuredValue = measuredValues[_slaId][_clauseId];

        bool isBreach = false;
        if (clause.operator == Operator.GreaterThan) {
            isBreach = measuredValue > clause.threshold;
        } else if (clause.operator == Operator.LessThan) {
            isBreach = measuredValue < clause.threshold;
        } else if (clause.operator == Operator.Equal) {
            isBreach = measuredValue == clause.threshold;
        } else if (clause.operator == Operator.NotEqual) {
            isBreach = measuredValue != clause.threshold;
        }

        if (isBreach) {
            return (EvalStatus.Breach, (sla.escrowValue * clause.penaltyBps) / 10000);
        }
        return (EvalStatus.NoBreach, 0);
    }

    function isParty(uint256 slaId, address user) external view returns (bool) {
        SLA storage sla = slas[slaId];
        return sla.isActive && (user == sla.buyer || user == sla.seller);
    }

    function getParties(uint256 slaId) external view returns (address buyer, address seller) {
        require(slas[slaId].isActive, "SLA not active");
        return (slas[slaId].buyer, slas[slaId].seller);
    }

    function getClause(uint256 _slaId, uint256 _clauseId) external view returns (
        DisputeType disputeType,
        Operator operator,
        uint256 threshold,
        uint256 penaltyBps
    ) {
        require(slas[_slaId].isActive, "SLA not active");
        require(_clauseId < slas[_slaId].clauseCount, "Invalid clauseId");
        Clause storage c = slas[_slaId].clauses[_clauseId];
        return (c.disputeType, c.operator, c.threshold, c.penaltyBps);
    }
}
