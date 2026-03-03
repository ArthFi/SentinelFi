// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {LoanFacility} from "../src/LoanFacility.sol";

contract LoanFacilityTest is Test {
    LoanFacility public facility;

    address public forwarder = address(0x1337);
    address public admin = address(this);
    bytes32 public LOAN_ID = keccak256(abi.encodePacked("LOAN-ACME-001"));

    bytes32 public LOAN_ID_2 = keccak256(abi.encodePacked("LOAN-BETA-002"));

    function setUp() public {
        facility = new LoanFacility(forwarder, admin);
        facility.registerLoan(LOAN_ID, 60000, 12500);
    }


    function _callReport(
        bytes32 loanId,
        uint256 leverage,
        uint256 dscr
    ) internal {
        bytes memory report = abi.encode(loanId, leverage, dscr);
        vm.prank(forwarder);
        facility.onReport("", report);
    }


    function test_HealthyCovenants() public {

        vm.expectEmit(true, false, false, true);
        emit LoanFacility.CovenantHealthy(
            LOAN_ID,
            50000,
            15000,
            block.timestamp
        );

        _callReport(LOAN_ID, 50000, 15000);

        LoanFacility.LoanTerms memory terms = facility.getLoanHealth(LOAN_ID);
        assertFalse(terms.isFrozen, "Loan should NOT be frozen for healthy covenants");
    }

    function test_LeverageBreach() public {

        vm.expectEmit(true, false, false, true);
        emit LoanFacility.LoanFrozen(LOAN_ID, block.timestamp);

        vm.expectEmit(true, false, false, true);
        emit LoanFacility.CovenantBreached(
            LOAN_ID,
            65000,
            15000,
            block.timestamp
        );

        _callReport(LOAN_ID, 65000, 15000);

        LoanFacility.LoanTerms memory terms = facility.getLoanHealth(LOAN_ID);
        assertTrue(terms.isFrozen, "Loan should be frozen on leverage breach");
    }

    function test_DscrBreach() public {

        _callReport(LOAN_ID, 50000, 10000);

        LoanFacility.LoanTerms memory terms = facility.getLoanHealth(LOAN_ID);
        assertTrue(terms.isFrozen, "Loan should be frozen on DSCR breach");
    }

    function test_BothBreach() public {

        _callReport(LOAN_ID, 70000, 9500);

        LoanFacility.LoanTerms memory terms = facility.getLoanHealth(LOAN_ID);
        assertTrue(terms.isFrozen, "Loan should be frozen when both covenants breach");
    }

    function test_BorderlineExact() public {

        _callReport(LOAN_ID, 60000, 12500);

        LoanFacility.LoanTerms memory terms = facility.getLoanHealth(LOAN_ID);
        assertFalse(
            terms.isFrozen,
            "Loan should NOT be frozen at exact threshold values"
        );
    }

    function test_RecoveryAfterBreach() public {
        _callReport(LOAN_ID, 70000, 9500);

        LoanFacility.LoanTerms memory breached = facility.getLoanHealth(LOAN_ID);
        assertTrue(breached.isFrozen, "Loan should be frozen after breach");

        vm.expectEmit(true, false, false, true);
        emit LoanFacility.LoanUnfrozen(LOAN_ID, block.timestamp);

        vm.expectEmit(true, false, false, true);
        emit LoanFacility.CovenantHealthy(
            LOAN_ID,
            45000,
            20000,
            block.timestamp
        );

        _callReport(LOAN_ID, 45000, 20000);

        LoanFacility.LoanTerms memory recovered = facility.getLoanHealth(LOAN_ID);
        assertFalse(recovered.isFrozen, "Loan should be unfrozen after recovery");
    }

    function test_OnlyForwarderCanReport() public {
        bytes memory report = abi.encode(LOAN_ID, uint256(50000), uint256(15000));

        vm.prank(address(0xDEAD));
        vm.expectRevert("LoanFacility: caller is not the Keystone Forwarder");
        facility.onReport("", report);
    }

    function test_UnregisteredLoanReverts() public {
        bytes32 unknownLoan = keccak256(abi.encodePacked("LOAN-UNKNOWN-999"));

        bytes memory report = abi.encode(
            unknownLoan,
            uint256(50000),
            uint256(15000)
        );

        vm.prank(forwarder);
        vm.expectRevert("LoanFacility: loan not registered");
        facility.onReport("", report);
    }

    function test_MultipleLoans() public {
        facility.registerLoan(LOAN_ID_2, 50000, 15000);

        _callReport(LOAN_ID, 70000, 9500);

        _callReport(LOAN_ID_2, 40000, 20000);

        LoanFacility.LoanTerms memory terms1 = facility.getLoanHealth(LOAN_ID);
        assertTrue(terms1.isFrozen, "Loan 1 should be frozen");

        LoanFacility.LoanTerms memory terms2 = facility.getLoanHealth(LOAN_ID_2);
        assertFalse(
            terms2.isFrozen,
            "Loan 2 should NOT be frozen - it is independent"
        );
    }

    function test_FrozenThenHealthyEmitsUnfrozen() public {
        vm.expectEmit(true, false, false, true);
        emit LoanFacility.LoanFrozen(LOAN_ID, block.timestamp);
        _callReport(LOAN_ID, 65000, 10000);

        LoanFacility.LoanTerms memory frozen = facility.getLoanHealth(LOAN_ID);
        assertTrue(frozen.isFrozen, "Loan should be frozen after breach");

        vm.expectEmit(true, false, false, true);
        emit LoanFacility.LoanUnfrozen(LOAN_ID, block.timestamp);
        _callReport(LOAN_ID, 50000, 15000);

        LoanFacility.LoanTerms memory unfrozen = facility.getLoanHealth(LOAN_ID);
        assertFalse(
            unfrozen.isFrozen,
            "Loan should be unfrozen after healthy report"
        );
    }


    function test_LastLeverageAndDscrStoredOnReport() public {
        _callReport(LOAN_ID, 50000, 15000);

        LoanFacility.LoanTerms memory terms = facility.getLoanHealth(LOAN_ID);
        assertEq(terms.lastLeverage, 50000, "lastLeverage should match report");
        assertEq(terms.lastDscr, 15000, "lastDscr should match report");
    }

    function test_GetLoanIds() public {
        bytes32[] memory ids = facility.getLoanIds();
        assertEq(ids.length, 1, "Should have 1 loan after setUp");
        assertEq(ids[0], LOAN_ID, "First loan ID should match");
    }

    function test_GetAllLoans() public {
        facility.registerLoan(LOAN_ID_2, 50000, 15000);

        (bytes32[] memory ids, LoanFacility.LoanTerms[] memory terms) = facility.getAllLoans();
        assertEq(ids.length, 2, "Should have 2 loans");
        assertEq(terms.length, 2, "Terms array should match");
        assertEq(terms[0].maxLeverageScaled, 60000);
        assertEq(terms[1].maxLeverageScaled, 50000);
    }

    function test_DuplicateLoanRegistrationReverts() public {
        vm.expectRevert("LoanFacility: loan already registered");
        facility.registerLoan(LOAN_ID, 60000, 12500);
    }

    function test_EmergencyPauseBlocksReports() public {
        facility.emergencyPause();

        bytes memory report = abi.encode(LOAN_ID, uint256(50000), uint256(15000));
        vm.prank(forwarder);
        vm.expectRevert();
        facility.onReport("", report);
    }

    function test_EmergencyUnpauseResumesReports() public {
        facility.emergencyPause();
        facility.emergencyUnpause();

        _callReport(LOAN_ID, 50000, 15000);
        LoanFacility.LoanTerms memory terms = facility.getLoanHealth(LOAN_ID);
        assertFalse(terms.isFrozen, "Should work after unpause");
    }

    function test_ConstructorZeroForwarderReverts() public {
        vm.expectRevert("LoanFacility: forwarder cannot be zero address");
        new LoanFacility(address(0), admin);
    }

    function test_ConstructorZeroAdminReverts() public {
        vm.expectRevert("LoanFacility: admin cannot be zero address");
        new LoanFacility(forwarder, address(0));
    }

    function test_NonAdminCannotRegisterLoan() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        facility.registerLoan(keccak256("NEW"), 50000, 15000);
    }
}