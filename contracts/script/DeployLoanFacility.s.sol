// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {LoanFacility} from "../src/LoanFacility.sol";

contract DeployLoanFacility is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address keystoneForwarder = vm.envAddress("KEYSTONE_FORWARDER");
        address admin = vm.envAddress("ADMIN_ADDRESS");

        vm.startBroadcast(deployerKey);

        LoanFacility facility = new LoanFacility(keystoneForwarder, admin);

        bytes32 loanId1 = keccak256(abi.encodePacked("LOAN-ACME-001"));
        facility.registerLoan(
            loanId1,
            60000,
            12500
        );

        bytes32 loanId2 = keccak256(abi.encodePacked("LOAN-BETA-002"));
        facility.registerLoan(
            loanId2,
            50000,
            15000
        );

        bytes32 loanId3 = keccak256(abi.encodePacked("LOAN-GAMMA-003"));
        facility.registerLoan(
            loanId3,
            45000,
            20000
        );

        vm.stopBroadcast();

        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("LoanFacility:", address(facility));
        console.log("LOAN-ACME-001:", vm.toString(loanId1));
        console.log("LOAN-BETA-002:", vm.toString(loanId2));
        console.log("LOAN-GAMMA-003:", vm.toString(loanId3));
        console.log("Update CONTRACT_ADDRESS in .env with:", address(facility));
    }
}