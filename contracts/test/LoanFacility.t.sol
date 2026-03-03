// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {LoanFacility} from "../src/LoanFacility.sol";

contract LoanFacilityTest is Test {
    LoanFacility public facility;

    address public forwarder = address(0x1337);
    address public admin = address(this);
    bytes32 public LOAN_ID = keccak256(abi.encodePacked("LOAN-ACME-001"));

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
}