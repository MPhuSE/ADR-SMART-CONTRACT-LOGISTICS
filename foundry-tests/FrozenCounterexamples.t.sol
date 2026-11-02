// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../contracts/SLAContract.sol";
import "../contracts/EvidenceVault.sol";
import "../contracts/DisputeRegistry.sol";
import "../contracts/DisputeResolution.sol";

interface Vm {
  function prank(address) external;
  function deal(address, uint256) external;
  function warp(uint256) external;
}

// Each fuzz parameter varies an execution input. Tests intentionally establish
// reachable violations of the desirable I1–I5 properties of the frozen code.
// Their PASS means the counterexample was witnessed; not that an invariant holds.
contract FrozenCounterexamplesFoundry {
  Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
  SLAContract sla;
  EvidenceVault evidence;
  DisputeRegistry registry;
  DisputeResolution resolution;

  address private constant buyer = address(0xB0B);
  address private constant seller = address(0xC0C);

  function setUp() public {
    sla = new SLAContract();
    evidence = new EvidenceVault();
    registry = new DisputeRegistry();
    resolution = new DisputeResolution(address(sla),address(evidence),address(registry));
    registry.grantRole(registry.RESOLUTION_ROLE(),address(resolution));
    SLAContract.Clause[] memory clauses = new SLAContract.Clause[](2);
    clauses[0] = SLAContract.Clause(SLAContract.DisputeType.Damage,SLAContract.Operator.GreaterThan,100,1000);
    clauses[1] = SLAContract.Clause(SLAContract.DisputeType.LateDelivery,SLAContract.Operator.GreaterThan,100,1000);
    sla.createSLA(buyer,seller,1 ether,clauses);
  }
  function register3(address first) internal {
    address[3] memory voters = [first,address(0xA02),address(0xA03)];
    for(uint i=0;i<3;i++) {
      vm.deal(voters[i],3 ether);
      vm.prank(voters[i]);
      registry.registerArbitrator{value:1 ether}();
    }
  }
  function zeroVoteFinal(uint256 id) internal {
    vm.warp(block.timestamp + 1 days + 2);
    resolution.transitionToReveal(id);
    vm.warp(block.timestamp + 1 days + 2);
    resolution.finalizeVote(id);
  }
  function testFuzz_I1_NoWinnerCanBeEnforced(uint8 offset) public {
    address first=address(uint160(0xA10 + uint160(offset)));
    if (first==address(0xA02)||first==address(0xA03)) first=address(0xB10);
    register3(first);
    resolution.createDispute(1,0,"");
    resolution.escalateToTier2(1);
    zeroVoteFinal(1);
    resolution.enforce(1);
    (,,,DisputeResolution.State state,DisputeResolution.Ruling ruling,)=resolution.disputes(1);
    assert(state==DisputeResolution.State.Enforced && ruling==DisputeResolution.Ruling.None);
  }
  function testFuzz_I2_ReRegistrationCausesDuplicatePanel(uint8 x) public {
    address a=address(uint160(0xB10+uint160(x)));
    if(a==address(0xA02)||a==address(0xA03))a=address(0xC10);
    register3(a);
    vm.prank(a);registry.unstake();
    vm.deal(a,2 ether);vm.prank(a);registry.registerArbitrator{value:1 ether}();
    address[] memory panel=registry.selectJury(2,3);
    assert(panel[1]==panel[2]);
  }
  function testFuzz_I3_ThirdPartyCanInitiateDispute(uint16 salt) public {
    address outsider=address(uint160(0xD00 + uint160(salt)));
    if(outsider==buyer || outsider==seller) outsider=address(0xF00);
    vm.prank(outsider);resolution.createDispute(1,0,"");
    (,,,DisputeResolution.State state,,)=resolution.disputes(1);
    assert(state==DisputeResolution.State.Disputed);
  }
  function testFuzz_I4_OracleCanReplaceObservation(uint16 v) public {
    uint256 magnitude=101+(uint256(v)%1000);
    sla.updateMeasuredValue(1,1,magnitude);
    (SLAContract.EvalStatus first,)=sla.evaluateClause(1,1);
    sla.updateMeasuredValue(1,1,90);
    (SLAContract.EvalStatus second,)=sla.evaluateClause(1,1);
    assert(first==SLAContract.EvalStatus.Breach && second==SLAContract.EvalStatus.NoBreach);
  }
  function testFuzz_I5_ImmediateEnforcementBlocksAppeal(uint8 rotation) public {
    address first=address(uint160(0xE10 + uint160(rotation)));
    if(first==address(0xA02)||first==address(0xA03))first=address(0xF10);
    register3(first);
    resolution.createDispute(1,0,"");resolution.escalateToTier2(1);
    zeroVoteFinal(1);resolution.enforce(1);
    vm.deal(seller,1 ether);
    vm.prank(seller);
    (bool ok,) = address(resolution).call{value:0.5 ether}(abi.encodeWithSelector(resolution.appealToTier3.selector,1));
    assert(!ok);
  }
}
