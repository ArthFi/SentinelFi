// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title LoanFacility
 * @notice Autonomous Private Credit Covenant Monitor - onchain enforcement layer.
 *         Receives AI-extracted covenant metrics from Chainlink CRE DON consensus
 *         via the Keystone Forwarder and auto-freezes loans on breach.
 *
 * @dev    Uses the manual Keystone Forwarder check pattern:
 *         - Only the Keystone Forwarder address (set in constructor) may call onReport().
 *         - onReport() decodes the report and delegates to _processReport().
 *         - If ReceiverTemplate becomes available in the installed Chainlink contracts
 *           package, this contract can be refactored to extend it instead.
 *
 *         Scaled integer convention (SCALE = 10_000):
 *           6.0x leverage  -> stored as 60_000
 *           1.25x DSCR     -> stored as 12_500
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


    /**
     * @notice Register a loan with its covenant thresholds (scaled by 10 000).
     * @param loanId        Unique identifier (use keccak256 of human-readable name).
     * @param maxLeverage   Maximum allowed leverage ratio × 10 000.
     * @param minDscr       Minimum required DSCR × 10 000.
     */
    function registerLoan(
        bytes32 loanId,
        uint256 maxLeverage,
        uint256 minDscr
    ) external onlyRole(ADMIN_ROLE) {
        require(maxLeverage > 0, "LoanFacility: maxLeverage must be > 0");
        require(minDscr > 0, "LoanFacility: minDscr must be > 0");
        require(
            loans[loanId].maxLeverageScaled == 0,
            "LoanFacility: loan already registered"
        );

        loans[loanId] = LoanTerms({
            maxLeverageScaled: maxLeverage,
            minDscrScaled: minDscr,
            lastLeverage: 0,
            lastDscr: 0,
            lastUpdated: block.timestamp,
            isFrozen: false
        });

        loanIds.push(loanId);
        emit LoanRegistered(loanId, maxLeverage, minDscr);
    }

    /**
     * @notice Entry point called by the Keystone Forwarder with CRE report data.
     * @param report    ABI-encoded (bytes32 loanId, uint256 leverage, uint256 dscr).
     */
    function onReport(
        bytes calldata ,
        bytes calldata report
    ) external onlyForwarder whenNotPaused {
        _processReport(report);
    }

    /**
     * @notice Emergency pause - halts all report processing.
     */
    function emergencyPause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Emergency unpause - resumes report processing.
     */
    function emergencyUnpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @notice Read the current health state of a loan.
     * @param loanId  The loan identifier.
     * @return terms  The full LoanTerms struct.
     */
    function getLoanHealth(
        bytes32 loanId
    ) external view returns (LoanTerms memory) {
        return loans[loanId];
    }

    /**
     * @notice Return all registered loan IDs.
     */
    function getLoanIds() external view returns (bytes32[] memory) {
        return loanIds;
    }

    /**
     * @notice Return all loans in one call (IDs + terms).
     */
    function getAllLoans()
        external
        view
        returns (bytes32[] memory ids, LoanTerms[] memory terms)
    {
        ids = loanIds;
        terms = new LoanTerms[](loanIds.length);
        for (uint256 i = 0; i < loanIds.length; i++) {
            terms[i] = loans[loanIds[i]];
        }
    }


    /**
     * @dev Decode the CRE report, evaluate covenants, and update loan state.
     *
     *      Encoding MUST match the viem call in workflow.ts:
     *        encodeAbiParameters(
     *          parseAbiParameters("bytes32 loanId, uint256 currentLeverage, uint256 currentDscr"),
     *          [config.loanId, leverageScaled, dscrScaled]
     *        )
     */
    function _processReport(bytes calldata report) internal {
        (
            bytes32 loanId,
            uint256 currentLeverage,
            uint256 currentDscr
        ) = abi.decode(report, (bytes32, uint256, uint256));

        LoanTerms storage loan = loans[loanId];

        require(
            loan.maxLeverageScaled > 0,
            "LoanFacility: loan not registered"
        );

        bool breached = (currentLeverage > loan.maxLeverageScaled) ||
            (currentDscr < loan.minDscrScaled);

        loan.lastUpdated = block.timestamp;
        loan.lastLeverage = currentLeverage;
        loan.lastDscr = currentDscr;

        if (breached) {
            if (!loan.isFrozen) {
                emit LoanFrozen(loanId, block.timestamp);
            }
            loan.isFrozen = true;
            emit CovenantBreached(
                loanId,
                currentLeverage,
                currentDscr,
                block.timestamp
            );
        } else {
            if (loan.isFrozen) {
                emit LoanUnfrozen(loanId, block.timestamp);
            }
            loan.isFrozen = false;
            emit CovenantHealthy(
                loanId,
                currentLeverage,
                currentDscr,
                block.timestamp
            );
        }
    }
}