// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { MulticallUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/MulticallUpgradeable.sol";

/**
 * @title MulticallStopOnFailureUpgradeable
 * @notice Extends OpenZeppelin's {MulticallUpgradeable} with a {multicallStopOnFailure}
 *         variant that returns early on the first failed sub-call instead of either
 *         (a) reverting the whole batch like the standard {multicall}, or
 *         (b) continuing past failures.
 * @dev    Designed for permissionless flows where the keeper bundles N homogeneous calls
 *         (e.g. `liquidateOrder(...)` × N) ordered most-likely-to-succeed first, and wants
 *         to keep the fees from the prefix that succeeded without paying gas to also try
 *         the suffix that's now provably going to fail (e.g. once the user is back above
 *         maintenance margin, every remaining `liquidateOrder` will revert
 *         `NotLiquidatable`). Equivalent to the inline `if (!_underwater) break;` pattern
 *         in legacy bespoke loops, but generalised to any failure mode (stale ids,
 *         races, etc.) without forfeiting prior work.
 *
 *         The standard {multicall} (revert-on-first-failure) is inherited unchanged and
 *         remains available for atomic bundles where partial execution is unacceptable.
 */
abstract contract MulticallStopOnFailureUpgradeable is MulticallUpgradeable {
    /// @notice A sub-call returned `(false, "")` — almost always an out-of-gas inside the
    ///         delegatecall (clean reverts emit at minimum a 4-byte selector). The whole
    ///         multicall reverts so `eth_estimateGas` finds a gas value that lets every
    ///         sub-call finish, instead of silently truncating the batch.
    error MulticallSubCallOutOfGas(uint256 index);

    /**
     * @notice Receives and executes a batch of function calls on this contract, stopping
     *         at (and including) the first sub-call that reverts. Earlier sub-calls keep
     *         their state changes and are reflected in the returned arrays.
     * @param  data       Encoded sub-call calldatas (same shape as {multicall}'s `data`).
     * @return successes  `successes[i] == true` for every successfully executed sub-call.
     *                    On the first failure, `successes[failurePoint] == false` and all
     *                    subsequent entries are `false` (untouched defaults). When every
     *                    sub-call succeeded, `successes[i] == true` for all `i`.
     * @return results    For successful sub-calls, the raw return data. For the failed
     *                    sub-call (if any), the raw revert payload. Untouched entries
     *                    after the failure are empty `bytes`.
     * @dev    Mirrors {MulticallUpgradeable.multicall}'s ERC-2771 context-suffix handling
     *         so `_msgSender()` resolves identically inside each sub-call.
     *
     *         Gas: a clean revert in a sub-call only burns the gas it actually used; the
     *         remaining sub-calls are skipped entirely, so the keeper doesn't pay for
     *         them. To prevent silent truncation when `eth_estimateGas` under-estimates
     *         (the parent frame keeps only ~1/64 of pre-call gas under EIP-150 after a
     *         delegatecall, which can make a downstream sub-call OOG), an empty-revert
     *         sub-call (`ok == false && returnData.length == 0`) reverts the whole batch
     *         with {MulticallSubCallOutOfGas}. This forces the gas estimator to find a
     *         value that lets every sub-call finish, while clean errored returns still
     *         participate in the normal stop-on-failure path.
     * @custom:oz-upgrades-unsafe-allow-reachable delegatecall
     */
    function multicallStopOnFailure(bytes[] calldata data)
        external
        virtual
        returns (bool[] memory successes, bytes[] memory results)
    {
        bytes memory context = msg.sender == _msgSender()
            ? new bytes(0)
            : msg.data[msg.data.length - _contextSuffixLength():];

        successes = new bool[](data.length);
        results = new bytes[](data.length);
        for (uint256 i = 0; i < data.length; i++) {
            (bool ok, bytes memory ret) = address(this).delegatecall(bytes.concat(data[i], context));
            successes[i] = ok;
            results[i] = ret;
            if (!ok) {
                // Empty revert payload almost always means OOG (clean Solidity reverts emit
                // at minimum a 4-byte selector). Surface it so the caller can fix gas rather
                // than silently truncating the batch.
                if (ret.length == 0) revert MulticallSubCallOutOfGas(i);
                break;
            }
        }
    }
}
