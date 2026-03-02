// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title LoanFacility
 * @notice Autonomous Private Credit Covenant Monitor - onchain enforcement layer.
 *         Receives AI-extracted covenant metrics from Chainlink CRE DON consensus
 *         via the Keystone Forwarder and auto-freezes loans on breach.
 */
contract LoanFacility is AccessControl, Pausable {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    address public immutable keystoneForwarder;

    struct LoanTerms {
        uint256 maxLeverageScaled;
        uint256 minDscrScaled;
        uint256 lastLeverage;
        uint256 lastDscr;
        uint256 lastUpdated;
        bool isFrozen;
    }

    mapping(bytes32 => LoanTerms) public loans;
    bytes32[] public loanIds;

    event CovenantBreached(
        bytes32 indexed loanId,
        uint256 leverage,
        uint256 dscr,
        uint256 timestamp
    );
    event CovenantHealthy(
        bytes32 indexed loanId,
        uint256 leverage,
        uint256 dscr,
        uint256 timestamp
    );
    event LoanFrozen(bytes32 indexed loanId, uint256 timestamp);
    event LoanUnfrozen(bytes32 indexed loanId, uint256 timestamp);
    event LoanRegistered(
        bytes32 indexed loanId,
        uint256 maxLeverageScaled,
        uint256 minDscrScaled
    );

    modifier onlyForwarder() {
        require(
            msg.sender == keystoneForwarder,
            "LoanFacility: caller is not the Keystone Forwarder"
        );
        _;
    }

    constructor(address _keystoneForwarder, address _admin) {
        require(
            _keystoneForwarder != address(0),
            "LoanFacility: forwarder cannot be zero address"
        );
        require(
            _admin != address(0),
            "LoanFacility: admin cannot be zero address"
        );

        keystoneForwarder = _keystoneForwarder;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);
    }
}