// SPDX-License-Identifier: BUSL-1.1
// Central Limit Order Book (CLOB) exchange
// (c) Long Gamma Labs, 2023-2025.
pragma solidity ^0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { ReentrancyGuardTransientUpgradeable } from
    "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardTransientUpgradeable.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { FixedPointMathLib } from "@solmate/src/utils/FixedPointMathLib.sol";

import { Errors } from "./Errors.sol";
import { FP24 } from "./FP24.sol";
import { IWatchDog } from "./IWatchDog.sol";
import { IOnchainCLOB } from "./IOnchainCLOB.sol";
import { IOnchainCLOBBidAskConsumer } from "./IOnchainCLOBBidAskConsumer.sol";
import { ITrie } from "./ITrie.sol";
import { ITrieFactory } from "./ITrieFactory.sol";
import { ITradeConsumer } from "./ITradeConsumer.sol";
import { IWETH } from "./IWETH.sol";

/// @title Trader structure
/// @notice Used to represent a trader's state within the LOB contract
/// @dev Stores trader's unique ID, claimable status and transfer tokens status
struct Trader {
    uint64 trader_id;
    ///< Unique identifier for the trader
    bool claimable;
    ///< Flag indicating if the trader's orders are claimable "automatically"
    bool transfer_tokens;
    ///< Flag indicating if the trader's tokens should be transferred from the LOB contract
    bool withdraw_as_native_eth;
}
///< Flag indicating if the trader's tokens should be withdrawn as native ETH

/// @title Trader Balances
/// @notice Structure to store the balance of token X and token Y for the trader
/// @dev Used to return the balance of token X and token Y for the trader
struct TraderBalances {
    uint128 token_x;
    ///< Balance of token X for the trader
    uint128 token_y;
}
///< Balance of token Y for the trader

/// @title Execution Result
/// @notice Structure to store information about the result of aggressive or immediate part of order execution
/// @dev Used to return data about the executed order from execution functions
struct ExecutionResult {
    uint64 order_id;
    /// order_id Unique identifier of the order
    uint128 executed_shares;
    /// executed_shares Number of shares/tokens executed in the aggressive part
    uint128 executed_value;
    /// executed_value Total value of the aggressively executed part of the order
    uint128 aggressive_fee;
}
/// aggressive_fee Fee for the aggressive execution

/// @title Market maker configuration
struct MarketMakerConfig {
    address marketmaker;
    /// Market maker address
    bool should_invoke_on_trade;
}
/// Invoke the onTrade method for the LP contract after each trade

/// @title Proxy Trading Permissions
struct ProxyTradingPermissions {
    bool allow_create;
    ///< Permission to create orders on behalf of the user
    bool allow_cancel;
}
///< Permission to cancel orders on behalf of the user

/// @title Limit Order Book (LOB) Contract for  Protocol
/// @notice Implements an on-chain limit order book for trading pairs
/// @dev Manages order placement, execution, and claiming processes
contract OnchainCLOB is
    IOnchainCLOB,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardTransientUpgradeable,
    PausableUpgradeable
{
    using FixedPointMathLib for uint256;
    using SafeCast for uint256;
    using SafeERC20 for IERC20;

    event OrderPlaced(
        address indexed owner,
        address indexed initiator,
        uint64 order_id,
        bool indexed isAsk,
        uint128 quantity,
        uint72 price,
        uint128 passive_shares,
        uint128 passive_fee,
        uint128 aggressive_shares,
        uint128 aggressive_value,
        uint128 aggressive_fee,
        bool market_only,
        bool post_only
    );
    event OrderClaimed(
        uint64 order_id,
        uint128 order_shares_remaining,
        uint128 token_x_sent,
        uint128 token_y_sent,
        uint128 passive_payout,
        bool only_claim
    );
    event TraderFilterEnabledUpdated(bool enabled);
    event AllowedTraderChanged(address indexed trader, bool isAllowed);
    event TraderConfigChanged(address indexed owner, bool claimable, bool transfer_tokens, bool withdraw_as_native_eth);
    event MarketMakerChanged(address new_marketmaker, address old_marketmaker);
    event PauserChanged(address new_pauser, address old_pauser);
    event FeesReceiverChanged(address new_fees_receiver, address old_fees_receiver);
    event Deposited(address indexed owner, uint128 token_x, uint128 token_y);
    event Withdrawn(address indexed owner, uint128 token_x, uint128 token_y);
    event ProxyTraderPermissionsChanged(
        address indexed owner, address indexed proxy_trader, bool allow_create, bool allow_cancel
    );

    uint8 constant nonce_length = 39;
    uint8 constant price_length = 24;
    uint256 constant wad = 1e18;

    uint256 scaling_factor_token_x;
    uint256 scaling_factor_token_y;

    MarketMakerConfig public marketMakerConfig;
    mapping(address => Trader) traders;
    mapping(address => TraderBalances) public traderBalances;
    mapping(address => bool) public allowedTraders;
    mapping(address => mapping(address => ProxyTradingPermissions)) public proxyTraderPermissions;

    uint256 accumulated_fees;

    uint64 admin_commission_rate;
    uint64 total_aggressive_commission_rate; // for market orders
    uint64 total_passive_commission_rate; // for out-of-money limit orders
    uint64 passive_order_payout_rate;

    IERC20 token_x;
    IERC20 token_y;
    bool supports_native_eth;
    bool is_token_x_weth;
    bool public traderFilterEnabled;
    uint64 public nonce;

    ITrie askTrie;
    ITrie bidTrie;
    uint64 last_used_trader_id;

    address public pauser;
    address public feesReceiver;

    IWatchDog internal immutable watchDog;
    IOnchainCLOBBidAskConsumer internal bidAskConsumer;

    modifier ensure(uint256 expires) {
        if (block.timestamp > expires) {
            revert Errors.Expired();
        }
        _;
    }

    modifier updateBidAskConsumer() {
        _;
        _updateBidAskConsumer();
    }

    constructor(address _watch_dog) {
        watchDog = IWatchDog(_watch_dog);
        _disableInitializers();
    }

    /// @notice Initialize lob contract state
    /// @dev Method is used instead of a constructor to initialize the contract state for compatibility with Upgradeable logic
    /// @param _trie_factory Trie factory
    /// @param _tokenXAddress Token X address
    /// @param _tokenYAddress Token Y address
    /// @param _supports_native_eth Indicates if the contract supports native ETH transactions
    /// @param _is_token_x_weth Indicates if token X is WETH (Wrapped Ether)
    /// @param scaling_token_x Scaling factor for token X
    /// @param scaling_token_y Scaling factor for token Y
    /// @param _administrator Administrator address
    /// @param _marketmaker Market maker address
    /// @param _pauser Pauser address
    /// @param _should_invoke_on_trade Flag indicating whether to invoke the onTrade method for the LP contract after each trade
    /// @param _admin_commission_rate The commission rate for the administrator
    /// @param _total_aggressive_commission_rate The total commission rate for aggressive orders
    /// @param _total_passive_commission_rate The total commission rate for passive orders
    /// @param _passive_order_payout_rate Payout for passive orders
    function initialize(
        address _trie_factory,
        address _tokenXAddress,
        address _tokenYAddress,
        bool _supports_native_eth,
        bool _is_token_x_weth,
        uint256 scaling_token_x,
        uint256 scaling_token_y,
        address _administrator,
        address _marketmaker,
        address _pauser,
        bool _should_invoke_on_trade,
        uint64 _admin_commission_rate,
        uint64 _total_aggressive_commission_rate,
        uint64 _total_passive_commission_rate,
        uint64 _passive_order_payout_rate
    ) external initializer {
        __UUPSUpgradeable_init();
        __Ownable_init(_administrator);
        __Ownable2Step_init();
        __ReentrancyGuardTransient_init();
        __Pausable_init();

        require(_trie_factory != address(0), Errors.AddressIsZero());
        require(_tokenXAddress != address(0), Errors.AddressIsZero());
        require(_tokenYAddress != address(0), Errors.AddressIsZero());

        nonce = (uint64(1) << nonce_length) - uint64(1);
        last_used_trader_id = 0;

        scaling_factor_token_x = scaling_token_x;
        scaling_factor_token_y = scaling_token_y;

        token_x = IERC20(_tokenXAddress);
        token_y = IERC20(_tokenYAddress);
        supports_native_eth = _supports_native_eth;
        is_token_x_weth = _is_token_x_weth;

        ITrieFactory trie_factory = ITrieFactory(_trie_factory);
        address ask_trie_address = trie_factory.createTrie(address(this));
        askTrie = ITrie(ask_trie_address);
        address bid_trie_address = trie_factory.createTrie(address(this));
        bidTrie = ITrie(bid_trie_address);

        pauser = _pauser;
        _changeMarketMaker(_marketmaker, _should_invoke_on_trade);

        uint256 max_rate = 2e17; // 20%
        require(
            _admin_commission_rate <= 1e18 && _total_aggressive_commission_rate <= max_rate
                && _total_passive_commission_rate <= max_rate && _passive_order_payout_rate <= max_rate
                && (_passive_order_payout_rate == 0 || _total_passive_commission_rate == 0),
            Errors.InvalidCommissionRate()
        );

        admin_commission_rate = _admin_commission_rate;
        total_aggressive_commission_rate = _total_aggressive_commission_rate;
        total_passive_commission_rate = _total_passive_commission_rate;
        passive_order_payout_rate = _passive_order_payout_rate;

        accumulated_fees = 1; // This is a simple trick to avoid zeroing out issue

        feesReceiver = _administrator;
    }

    /// @notice Returns the contract configuration
    /// @dev This function provides access to the main contract parameters such as scaling factors, commissions, and token addresses
    /// @return _scaling_factor_token_x Scaling factor for token X
    /// @return _scaling_factor_token_y Scaling factor for token Y
    /// @return _token_x Address of token X
    /// @return _token_y Address of token Y
    /// @return _supports_native_eth Indicates if the contract supports native ETH transactions
    /// @return _is_token_x_weth Indicates if token X is WETH (Wrapped Ether)
    /// @return _ask_trie Address of askTrie
    /// @return _bid_trie Address of bidTrie
    /// @return _admin_commission_rate The commission rate for the administrator
    /// @return _total_aggressive_commission_rate The total commission rate for aggressive orders
    /// @return _total_passive_commission_rate The total commission rate for passive orders
    /// @return _passive_order_payout_rate Payout for passive orders
    /// @return _should_invoke_on_trade Flag indicating whether to invoke the onTrade method for the LP contract after each trade
    function getConfig()
        external
        view
        returns (
            uint256 _scaling_factor_token_x,
            uint256 _scaling_factor_token_y,
            address _token_x,
            address _token_y,
            bool _supports_native_eth,
            bool _is_token_x_weth,
            address _ask_trie,
            address _bid_trie,
            uint64 _admin_commission_rate,
            uint64 _total_aggressive_commission_rate,
            uint64 _total_passive_commission_rate,
            uint64 _passive_order_payout_rate,
            bool _should_invoke_on_trade
        )
    {
        return (
            scaling_factor_token_x,
            scaling_factor_token_y,
            address(token_x),
            address(token_y),
            supports_native_eth,
            is_token_x_weth,
            address(askTrie),
            address(bidTrie),
            admin_commission_rate,
            total_aggressive_commission_rate,
            total_passive_commission_rate,
            passive_order_payout_rate,
            marketMakerConfig.should_invoke_on_trade
        );
    }

    /// @notice Fallback function to handle incoming ETH deposits.
    receive() external payable {
        require(
            supports_native_eth
                && (
                    (is_token_x_weth && msg.sender == address(token_x))
                        || (!is_token_x_weth && msg.sender == address(token_y))
                ),
            Errors.Forbidden()
        );
    }

    /// @notice Retrieves the config of a trader by address in tokens stored on the LOB contract
    /// @dev Returns the balances of tokens X and Y, and the claimable and transfer tokens status for the specified address
    /// @param address_ The address of the trader for whom the balance is being retrieved
    /// @return claimable Status indicating whether the user's orders can be automatically claimed from other addresses
    /// @return transfer_tokens Status indicating whether the trader's tokens should be transferred from the LOB contract
    /// @return withdraw_as_native_eth Status indicating whether the trader's tokens should be withdrawn as native ETH
    function getTraderConfig(address address_) external view returns (bool, bool, bool) {
        Trader memory trader = traders[address_];
        if (trader.trader_id == 0) {
            trader.claimable = true; // true by default
            trader.transfer_tokens = true; // true by default
            trader.withdraw_as_native_eth = true; // true by default
        }
        return (trader.claimable, trader.transfer_tokens, trader.withdraw_as_native_eth);
    }

    /// @notice Returns the current bid/ask consumer contract address
    /// @return Address of the bid/ask consumer contract, or zero address if not set
    function getBidAskConsumerAddress() external view returns (address) {
        return address(bidAskConsumer);
    }

    /// @notice Returns the current watchdog contract address
    /// @return Address of the watchdog contract
    function getWatchDogAddress() external view returns (address) {
        return address(watchDog);
    }

    /// @notice Allows the administrator to change the market maker address
    /// @param _marketmaker The new address of the market maker
    /// @param _should_invoke_on_trade Flag indicating that the market maker must implement ITradeConsumer
    /// @param _admin_commission_rate The commission rate for the administrator
    /// @dev If the market maker address is null, it can be set by anyone
    function changeMarketMaker(address _marketmaker, bool _should_invoke_on_trade, uint64 _admin_commission_rate)
        external
        nonReentrant
    {
        address administrator = owner();
        require(msg.sender == administrator, Errors.Forbidden());

        _transferFees();

        require(_admin_commission_rate <= 1e18, Errors.InvalidCommissionRate());
        admin_commission_rate = _admin_commission_rate;

        address marketmaker = marketMakerConfig.marketmaker;

        if (marketmaker != _marketmaker) {
            emit MarketMakerChanged(_marketmaker, marketmaker);
        }

        _changeMarketMaker(_marketmaker, _should_invoke_on_trade);
    }

    /// @notice The new owner accepts the ownership transfer.
    function acceptOwnership() public override nonReentrant {
        _transferFees();
        super.acceptOwnership();
    }

    /// @notice Sets the claimable status and transfer tokens status for the trader calling the function
    /// @param is_claimable The new claimable status
    /// @param transfer_tokens The new transfer tokens status
    /// @param withdraw_as_native_eth The new withdraw as native ETH status
    function setTraderConfig(bool is_claimable, bool transfer_tokens, bool withdraw_as_native_eth)
        external
        nonReentrant
        whenNotPaused
    {
        _getOrCreateTraderId(msg.sender);
        traders[msg.sender].claimable = is_claimable;
        traders[msg.sender].transfer_tokens = transfer_tokens;
        traders[msg.sender].withdraw_as_native_eth = withdraw_as_native_eth;
        emit TraderConfigChanged(msg.sender, is_claimable, transfer_tokens, withdraw_as_native_eth);
    }

    /// @notice Sets the bid/ask consumer contract address
    /// @dev Setting to address(0) effectively disables bid/ask updates
    /// @param consumerAddress The address of the bid/ask consumer contract
    function setBidAskConsumer(address consumerAddress) external onlyOwner {
        bidAskConsumer = IOnchainCLOBBidAskConsumer(consumerAddress);
        _updateBidAskConsumer();
    }

    /// @notice Updates the trader filter enabled status
    /// @param _enabled Boolean flag indicating whether trader filter should be enabled (true) or disabled (false)
    function setTraderFilterEnabled(bool _enabled) external onlyOwner {
        bool currentStatus = traderFilterEnabled;
        if (currentStatus == _enabled) {
            return; // No change needed
        }

        traderFilterEnabled = _enabled;

        emit TraderFilterEnabledUpdated(_enabled);
    }

    /// @notice Updates the allowed status of a trader address
    /// @dev Only callable by the contract owner. Updates the allowedTraders mapping to enable/disable a trader
    /// @param trader The address of the trader to update
    /// @param isAllowed Boolean flag indicating whether the trader should be allowed (true) or disallowed (false)
    function setAllowedTrader(address trader, bool isAllowed) external onlyOwner {
        bool currentStatus = allowedTraders[trader];
        if (currentStatus == isAllowed) {
            return; // No change needed
        }

        allowedTraders[trader] = isAllowed;

        emit AllowedTraderChanged(trader, isAllowed);
    }

    /// @notice Tries to permit the token approval for the LOB contract using EIP-2612 standard
    /// @param is_token_x Indicates if the token is token X (true) or token Y (false)
    /// @param value The amount of tokens to approve
    /// @param expires The time at which the approval transaction will expire
    /// @param v The recovery ID
    /// @param r The r value of the signature
    /// @param s The s value of the signature
    function tryPermitEIP2612(bool is_token_x, uint256 value, uint256 expires, uint8 v, bytes32 r, bytes32 s)
        external
        whenNotPaused
    {
        address token_address = is_token_x ? address(token_x) : address(token_y);
        IERC20Permit token = IERC20Permit(token_address);

        try token.permit(msg.sender, address(this), value, expires, v, r, s) { } catch { }
    }

    /// @param isAsk Indicates if the order is a sell order (true) or a buy order (false)
    /// @param quantity The amount of tokens to order divided by the scaling factor. This amount would be multiplied by the scaling factor inside the function
    /// @param price The price per token in the order, no more than 6 significant digits
    /// @param max_commission The maximum commission, which may include passive and/or aggressive fee
    /// @param market_only Indicates if the order should be executed only against existing orders in the market
    /// @param post_only Indicates if the order should be posted only and not executed immediately
    ///                  Note: Post-only orders can be griefed via front-running. If this is a concern,
    ///                  consider using post_only = false with a small max_commission to achieve similar behavior
    ///                  without the front-running vulnerability.
    /// @param transfer_executed_tokens Flag for transferring executed tokens (true) or crediting them to the balance (false)
    /// @param expires The time at which the transaction will expire. After this time, the transaction will be reverted
    /// @return order_id The identifier of the created order
    /// @return executed_shares Number of executed shares
    /// @return executed_value Executed value
    /// @return aggressive_fee Aggressive fee
    function placeOrder(
        bool isAsk,
        uint128 quantity,
        uint72 price,
        uint128 max_commission,
        bool market_only,
        bool post_only,
        bool transfer_executed_tokens,
        uint256 expires
    )
        external
        payable
        ensure(expires)
        whenNotPaused
        returns (uint64 order_id, uint128 executed_shares, uint128 executed_value, uint128 aggressive_fee)
    {
        if (traders[msg.sender].trader_id == 0) {
            _getOrCreateTraderId(msg.sender);
        }

        ExecutionResult memory result = _placeOrder(
            isAsk,
            quantity,
            price,
            max_commission,
            market_only,
            post_only,
            transfer_executed_tokens,
            traders[msg.sender].withdraw_as_native_eth,
            msg.sender
        );
        order_id = result.order_id;
        executed_shares = result.executed_shares;
        executed_value = result.executed_value;
        aggressive_fee = result.aggressive_fee;

        _invokeTradeConsumerCallback(result.executed_shares, isAsk);
    }

    /// @param isAsk Indicates if the order is a sell order (true) or a buy order (false)
    /// @param quantity The amount of tokens to order divided by the scaling factor. This amount would be multiplied by the scaling factor inside the function
    /// @param price The price per token in the order, no more than 6 significant digits
    /// @param max_commission The maximum commission, which may include passive and/or aggressive fee
    /// @param market_only Indicates if the order should be executed only against existing orders in the market
    /// @param post_only Indicates if the order should be posted only and not executed immediately
    ///                  Note: Post-only orders can be griefed via front-running. If this is a concern,
    ///                  consider using post_only = false with a small max_commission to achieve similar behavior
    ///                  without the front-running vulnerability.
    /// @param transfer_executed_tokens Flag for transferring executed tokens (true) or crediting them to the balance (false)
    /// @param withdraw_as_native_eth Flag for withdrawing as native ETH (true) or as ERC20 tokens (false)
    /// @param order_owner The address of the order owner
    /// @param expires The time at which the transaction will expire. After this time, the transaction will be reverted
    /// @return order_id The identifier of the created order
    /// @return executed_shares Number of executed shares
    /// @return executed_value Executed value
    /// @return aggressive_fee Aggressive fee
    function placeOrderByProxy(
        bool isAsk,
        uint128 quantity,
        uint72 price,
        uint128 max_commission,
        bool market_only,
        bool post_only,
        bool transfer_executed_tokens,
        bool withdraw_as_native_eth,
        address order_owner,
        uint256 expires
    )
        external
        payable
        ensure(expires)
        whenNotPaused
        returns (uint64 order_id, uint128 executed_shares, uint128 executed_value, uint128 aggressive_fee)
    {
        require(proxyTraderPermissions[order_owner][msg.sender].allow_create, Errors.Forbidden());

        ExecutionResult memory result = _placeOrder(
            isAsk,
            quantity,
            price,
            max_commission,
            market_only,
            post_only,
            transfer_executed_tokens,
            withdraw_as_native_eth,
            order_owner
        );
        order_id = result.order_id;
        executed_shares = result.executed_shares;
        executed_value = result.executed_value;
        aggressive_fee = result.aggressive_fee;

        _invokeTradeConsumerCallback(result.executed_shares, isAsk);
    }

    /// @notice Places a market order with a target token Y
    /// @param isAsk Order direction: true for sell (ask), false for buy (bid)
    /// @param target_token_y_value Target value of token Y for execution
    /// @param price Order price
    /// @param max_commission Maximum commission
    /// @param transfer_executed_tokens Flag for transferring executed tokens
    /// @param expires The time at which the transaction will expire. After this time, the transaction will be reverted
    /// @return executed_shares Number of executed shares
    /// @return executed_value Executed value
    /// @return aggressive_fee Aggressive fee
    function placeMarketOrderWithTargetValue(
        bool isAsk,
        uint128 target_token_y_value,
        uint72 price,
        uint128 max_commission,
        bool transfer_executed_tokens,
        uint256 expires
    )
        external
        payable
        ensure(expires)
        whenNotPaused
        returns (uint128 executed_shares, uint128 executed_value, uint128 aggressive_fee)
    {
        uint24 packed_price = FP24.packFP24(price);
        uint64 price_id = _genPriceId(packed_price, isAsk);

        uint128 order_quantity;
        uint128 total_fees_and_payout_rate = total_aggressive_commission_rate + passive_order_payout_rate;
        if (isAsk) {
            uint128 adjusted_token_y_value =
                uint256(target_token_y_value).mulDivDown(wad, wad - total_fees_and_payout_rate).toUint128();
            (order_quantity,) = bidTrie.previewExecuteRight(price_id, type(uint128).max, adjusted_token_y_value);
        } else {
            uint128 adjusted_token_y_value =
                uint256(target_token_y_value).mulDivDown(wad, wad + total_fees_and_payout_rate).toUint128();
            (order_quantity,) = askTrie.previewExecuteRight(price_id, type(uint128).max, adjusted_token_y_value);
        }

        if (traders[msg.sender].trader_id == 0) {
            _getOrCreateTraderId(msg.sender);
        }

        ExecutionResult memory result = _placeOrder(
            isAsk,
            order_quantity,
            price,
            max_commission,
            true, // market_only
            false, // post_only
            transfer_executed_tokens,
            traders[msg.sender].withdraw_as_native_eth,
            msg.sender
        );
        executed_shares = result.executed_shares;
        executed_value = result.executed_value;
        aggressive_fee = result.aggressive_fee;

        _invokeTradeConsumerCallback(result.executed_shares, isAsk);
    }

    /// @notice Places a market order with a target token Y by proxy trader
    /// @param isAsk Order direction: true for sell (ask), false for buy (bid)
    /// @param target_token_y_value Target value of token Y for execution
    /// @param price Order price
    /// @param max_commission Maximum commission
    /// @param transfer_executed_tokens Flag for transferring executed tokens
    /// @param withdraw_as_native_eth Flag for withdrawing as native ETH (true) or as ERC20 tokens (false)
    /// @param order_owner The address of the order owner
    /// @param expires The time at which the transaction will expire. After this time, the transaction will be reverted
    /// @return executed_shares Number of executed shares
    /// @return executed_value Executed value
    /// @return aggressive_fee Aggressive fee
    function placeMarketOrderWithTargetValueByProxy(
        bool isAsk,
        uint128 target_token_y_value,
        uint72 price,
        uint128 max_commission,
        bool transfer_executed_tokens,
        bool withdraw_as_native_eth,
        address order_owner,
        uint256 expires
    )
        external
        payable
        ensure(expires)
        whenNotPaused
        returns (uint128 executed_shares, uint128 executed_value, uint128 aggressive_fee)
    {
        require(proxyTraderPermissions[order_owner][msg.sender].allow_create, Errors.Forbidden());

        uint24 packed_price = FP24.packFP24(price);
        uint64 price_id = _genPriceId(packed_price, isAsk);

        uint128 order_quantity;
        uint128 total_fees_and_payout_rate = total_aggressive_commission_rate + passive_order_payout_rate;
        if (isAsk) {
            uint128 adjusted_token_y_value =
                uint256(target_token_y_value).mulDivDown(wad, wad - total_fees_and_payout_rate).toUint128();
            (order_quantity,) = bidTrie.previewExecuteRight(price_id, type(uint128).max, adjusted_token_y_value);
        } else {
            uint128 adjusted_token_y_value =
                uint256(target_token_y_value).mulDivDown(wad, wad + total_fees_and_payout_rate).toUint128();
            (order_quantity,) = askTrie.previewExecuteRight(price_id, type(uint128).max, adjusted_token_y_value);
        }

        ExecutionResult memory result = _placeOrder(
            isAsk,
            order_quantity,
            price,
            max_commission,
            true, // market_only
            false, // post_only
            transfer_executed_tokens,
            withdraw_as_native_eth,
            order_owner
        );
        executed_shares = result.executed_shares;
        executed_value = result.executed_value;
        aggressive_fee = result.aggressive_fee;

        _invokeTradeConsumerCallback(result.executed_shares, isAsk);
    }

    /// @notice Allows a trader to claim or fully cancel the order
    /// @param order_owner The address of the order owner
    /// @param order_id The identifier of the order to claim
    /// @param only_claim A flag indicating that only the executed part of the order should be sent
    /// without unnecessarily removing the order.
    /// @param transfer_tokens Flag for transferring executed tokens (true) or crediting them to the balance (false).
    /// Ignored if msg.sender is not the order owner.
    /// @param withdraw_as_native_eth Flag for withdrawing as native ETH (true) or as ERC20 tokens (false).
    /// Ignored if msg.sender is not the order owner.
    /// @param expires The time at which the transaction will expire. After this time, the transaction will be reverted
    function claimOrder(
        address order_owner,
        uint64 order_id,
        bool only_claim,
        bool transfer_tokens,
        bool withdraw_as_native_eth,
        uint256 expires
    ) external ensure(expires) nonReentrant updateBidAskConsumer whenNotPaused {
        uint64 trader_id = _getOrCreateTraderId(order_owner);

        bool privileged_sender =
            ((msg.sender == order_owner) || proxyTraderPermissions[order_owner][msg.sender].allow_cancel);

        if (!privileged_sender) {
            require(traders[order_owner].claimable, Errors.ClaimNotAllowed());

            transfer_tokens = traders[order_owner].transfer_tokens;
            withdraw_as_native_eth = traders[order_owner].withdraw_as_native_eth;
        }

        (bool isAsk, uint72 price) = _extractDirectionAndPrice(order_id);

        uint128 x_to_send;
        uint128 y_to_send;

        uint128 total_shares;
        uint128 remain_shares;

        uint128 order_shares_remaining = 0;

        if (isAsk) {
            if (only_claim) {
                uint128 executed_shares;
                (executed_shares, order_shares_remaining) = askTrie.claimExecuted(order_id, trader_id);

                total_shares = executed_shares;
                remain_shares = 0;
            } else {
                (total_shares, remain_shares) = askTrie.removeOrder(order_id, trader_id);
                if (total_shares == 0) {
                    return;
                }
            }

            uint128 executed_value = (total_shares - remain_shares) * price;
            uint128 fees = _calculateTotalPassiveCommission(executed_value);

            x_to_send = remain_shares;
            y_to_send = executed_value - fees;
        } else {
            if (only_claim) {
                uint128 executed_shares;
                (executed_shares, order_shares_remaining) = bidTrie.claimExecuted(order_id | 0x1, trader_id);

                total_shares = executed_shares;
                remain_shares = 0;
            } else {
                (total_shares, remain_shares) = bidTrie.removeOrder(order_id | 0x1, trader_id);
                if (total_shares == 0) {
                    return;
                }
            }

            x_to_send = total_shares - remain_shares;
            y_to_send = remain_shares * price;
        }

        (uint128 passive_payout, uint256 fee_rounding_error) =
            _calculatePassiveOrderPayoutOrRefundedCommissions(isAsk, price, remain_shares, total_shares);
        emit OrderClaimed(order_id, order_shares_remaining, x_to_send, y_to_send, passive_payout, only_claim);
        y_to_send += passive_payout;
        accumulated_fees += fee_rounding_error;

        require((remain_shares == 0) || privileged_sender, Errors.OnlyPrivilegedSenderCanCancelOrders());

        _handleTokenTransfer(order_owner, transfer_tokens, x_to_send, 0, y_to_send, 0, withdraw_as_native_eth);
    }

    /// @notice Deposits the specified amounts of token X and token Y into the trader's balance on the contract
    /// @param token_x_amount The amount of token X to deposit
    /// @param token_y_amount The amount of token Y to deposit
    function depositTokens(uint128 token_x_amount, uint128 token_y_amount) external nonReentrant whenNotPaused {
        uint256 actual_token_x_to_receive = 0;
        uint256 actual_token_y_to_receive = 0;

        if (token_x_amount > 0) {
            traderBalances[msg.sender].token_x += token_x_amount;
            actual_token_x_to_receive = _convertToActualTokenXAmount(token_x_amount);
        }

        if (token_y_amount > 0) {
            traderBalances[msg.sender].token_y += token_y_amount;
            actual_token_y_to_receive = _convertToActualTokenYAmount(token_y_amount);
        }

        // actual erc20 transactions
        if (actual_token_x_to_receive > 0) {
            _safeTransferFromWithBalanceCheck(token_x, msg.sender, actual_token_x_to_receive);
        }
        if (actual_token_y_to_receive > 0) {
            _safeTransferFromWithBalanceCheck(token_y, msg.sender, actual_token_y_to_receive);
        }

        emit Deposited(msg.sender, token_x_amount, token_y_amount);
    }

    /// @notice Withdraws specified amounts of token X and token Y from the trader's balance on the contract
    /// @param withdraw_all If set to true, withdraws all the trader's tokens; otherwise, uses the specified amounts
    /// @param token_x_amount The amount of token X to withdraw (ignored if withdraw_all = true)
    /// @param token_y_amount The amount of token Y to withdraw (ignored if withdraw_all = true)
    /// @param withdraw_as_native_eth Flag for withdrawing as native ETH (true) or as ERC20 tokens (false)
    function withdrawTokens(
        bool withdraw_all,
        uint128 token_x_amount,
        uint128 token_y_amount,
        bool withdraw_as_native_eth
    ) external nonReentrant whenNotPaused {
        uint256 actual_token_x_to_send = 0;
        uint256 actual_token_y_to_send = 0;

        uint128 clients_shares = traderBalances[msg.sender].token_x;
        uint128 clients_value = traderBalances[msg.sender].token_y;

        if (withdraw_all) {
            token_x_amount = clients_shares;
            token_y_amount = clients_value;
        }

        if (token_x_amount > 0) {
            require(clients_shares >= token_x_amount, Errors.InsufficientTokenXBalance());
            unchecked {
                traderBalances[msg.sender].token_x = clients_shares - token_x_amount;
            }

            actual_token_x_to_send = _convertToActualTokenXAmount(token_x_amount);
        }

        if (token_y_amount > 0) {
            require(clients_value >= token_y_amount, Errors.InsufficientTokenYBalance());
            unchecked {
                traderBalances[msg.sender].token_y = clients_value - token_y_amount;
            }

            actual_token_y_to_send = _convertToActualTokenYAmount(token_y_amount);
        }

        // actual erc20 transactions
        if (actual_token_x_to_send > 0) {
            if (supports_native_eth && is_token_x_weth && withdraw_as_native_eth) {
                _sendETH(msg.sender, actual_token_x_to_send);
            } else {
                token_x.safeTransfer(msg.sender, actual_token_x_to_send);
            }
        }
        if (actual_token_y_to_send > 0) {
            if (supports_native_eth && !is_token_x_weth && withdraw_as_native_eth) {
                _sendETH(msg.sender, actual_token_y_to_send);
            } else {
                token_y.safeTransfer(msg.sender, actual_token_y_to_send);
            }
        }

        emit Withdrawn(msg.sender, token_x_amount, token_y_amount);
    }

    /// @notice Returns the accumulated fees in both token amount and internal units
    /// @dev The raw_fees represent internal accounting with wad scaling (1e18)
    ///      token_amount represents the actual transferable token quantity
    /// @return token_amount The accumulated fees in actual token amount (human-readable)
    /// @return raw_fees The accumulated fees in internal scaled units (wad precision)
    function getAccumulatedFees() external view returns (uint256 token_amount, uint256 raw_fees) {
        raw_fees = accumulated_fees - 1;
        uint256 total_fees = raw_fees / wad;
        token_amount = _convertToActualTokenYAmount(total_fees.toUint128());
    }

    /// @notice Transfers the accumulated commissions to the administrator and marketmaker.
    function transferFees() external whenNotPaused {
        _transferFees();
    }

    /// @notice Pause contract
    /// @dev Can be called by administrator and pauser
    function pause() external {
        require(msg.sender == owner() || msg.sender == pauser, Errors.Forbidden());
        _pause();
    }

    /// @notice Unpause contract
    /// @dev Can be called by administrator
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Change pauser by administrator
    /// @param pauser_ New pauser address
    /// @dev Can be called only by administrator
    function changePauser(address pauser_) external onlyOwner {
        if (pauser == pauser_) {
            return;
        }

        emit PauserChanged(pauser_, pauser);
        pauser = pauser_;
    }

    /// @notice Executes a batch of functions
    /// @param data Array of function data
    function batchExecute(bytes[] calldata data) external returns (bytes[] memory results) {
        results = new bytes[](data.length);

        for (uint256 i = 0; i < data.length; i++) {
            (bool success, bytes memory result) = address(this).delegatecall(data[i]);
            if (!success) {
                revert(string(abi.encodePacked("[", Strings.toString(i), "] ", _getRevertMsg(result))));
            }
            results[i] = result;
        }
    }

    /// @notice Change fees receiver by administrator
    /// @param fees_receiver New fees receiver address
    /// @dev Can be called only by administrator
    function changeFeesReceiver(address fees_receiver) external onlyOwner {
        require(fees_receiver != address(0), Errors.AddressIsZero());

        if (feesReceiver == fees_receiver) {
            return;
        }

        _transferFees();

        emit FeesReceiverChanged(fees_receiver, feesReceiver);
        feesReceiver = fees_receiver;
    }

    /// @notice Sets the trading permissions for a proxy trader
    /// @param proxy_trader The address of the proxy trader
    /// @param allow_create Permission to create orders on behalf of the user
    /// @param allow_cancel Permission to cancel orders on behalf of the user
    function setProxyTraderPermissions(address proxy_trader, bool allow_create, bool allow_cancel) external {
        proxyTraderPermissions[msg.sender][proxy_trader] =
            ProxyTradingPermissions({ allow_create: allow_create, allow_cancel: allow_cancel });

        emit ProxyTraderPermissionsChanged(msg.sender, proxy_trader, allow_create, allow_cancel);
    }

    /// @notice Extracts the direction and price from the given order ID.
    /// @param order_id The unique identifier of the order.
    /// @return isAsk A boolean indicating if the order is an ask (true) or a bid (false).
    /// @return price The price of the order.
    function _extractDirectionAndPrice(uint64 order_id) internal pure returns (bool isAsk, uint72 price) {
        // Orders with an order_id ending in 1 are asks, and those ending in 0 are bids.
        isAsk = (order_id & uint64(0x1)) == 0x1;

        uint24 packed_price = uint24(order_id >> (nonce_length + 1));
        if (isAsk) {
            unchecked {
                packed_price = type(uint24).max - packed_price;
            }
        }
        price = FP24.unPackFP24(packed_price);
    }

    function _authorizeUpgrade(address) internal override onlyOwner { }

    /// @param isAsk Indicates if the order is a sell order (true) or a buy order (false)
    /// @param quantity The amount of tokens to order divided by the scaling factor. This amount would be multiplied by the scaling factor inside the function
    /// @param price The price per token in the order, no more than 6 significant digits
    /// @param max_commission The maximum commission, which may include passive and/or aggressive fee
    /// @param market_only Indicates if the order should be executed only against existing orders in the market
    /// @param post_only Indicates if the order should be posted only and not executed immediately
    ///                  Note: Post-only orders can be griefed via front-running. If this is a concern,
    ///                  consider using post_only = false with a small max_commission to achieve similar behavior
    ///                  without the front-running vulnerability.
    /// @param transfer_executed_tokens Flag for transferring executed tokens (true) or crediting them to the balance (false)
    /// @param withdraw_as_native_eth Flag for withdrawing as native ETH (true) or as ERC20 tokens (false)
    /// @param order_owner The address of the order owner
    /// @return execution_result ExecutionResult structure containing information about the executed order
    function _placeOrder(
        bool isAsk,
        uint128 quantity,
        uint72 price,
        uint128 max_commission,
        bool market_only,
        bool post_only,
        bool transfer_executed_tokens,
        bool withdraw_as_native_eth,
        address order_owner
    ) internal nonReentrant updateBidAskConsumer returns (ExecutionResult memory execution_result) {
        if (traderFilterEnabled) {
            require(allowedTraders[msg.sender], Errors.NotATrader());
        }
        require(!market_only || !post_only, Errors.MarketOnlyAndPostOnlyFlagsConflict());
        require(quantity != 0 && price != 0, Errors.ZeroTokenTransferNotAllowed());

        require(msg.value == 0 || (supports_native_eth && (isAsk == is_token_x_weth)), Errors.NativeETHDisabled());

        uint24 packed_price = FP24.packFP24(price);
        uint64 price_id = _genPriceId(packed_price, isAsk);

        if (post_only) {
            bool aggressive_trade = false;
            if (isAsk) {
                if (price_id <= bidTrie.best_offer()) {
                    aggressive_trade = true;
                }
            } else {
                if (price_id <= askTrie.best_offer()) {
                    aggressive_trade = true;
                }
            }
            if (aggressive_trade) {
                if (msg.value > 0) {
                    _sendETH(msg.sender, msg.value);
                }

                emit OrderPlaced(
                    order_owner,
                    msg.sender,
                    0x0, // order_id
                    isAsk,
                    quantity,
                    price,
                    0, // passive_shares,
                    0, // passive_fee
                    0, // executed_shares
                    0, // executed_value
                    0, // aggressive_fee
                    false, // market_only,
                    true // post_only
                );

                return execution_result;
            }
        }

        uint128 x_to_send;
        uint128 y_to_send;

        uint128 x_to_receive;
        uint128 y_to_receive;

        // processing aggressive part
        uint128 executed_shares;
        uint128 executed_value;
        uint128 aggressive_fee;
        if (!post_only) {
            if (isAsk) {
                (executed_shares, executed_value) = bidTrie.executeRight(price_id, quantity);

                x_to_receive = executed_shares;
                y_to_send = executed_value;
            } else {
                (executed_shares, executed_value) = askTrie.executeRight(price_id, quantity);

                x_to_send = executed_shares;
                y_to_receive = executed_value;
            }
            aggressive_fee = _calculateAndTransferTotalAggressiveFeesAndPayout(executed_value);
            y_to_receive += aggressive_fee;

            if (executed_shares > 0) {
                require(watchDog.isChainStable(), Errors.ChainIsUnstableForTrades());
            }

            execution_result.executed_shares = executed_shares;
            execution_result.executed_value = executed_value;
            execution_result.aggressive_fee = aggressive_fee;
        }

        // processing passive part
        uint64 order_id;
        uint128 passive_shares = !market_only ? (quantity - executed_shares) : 0;
        uint128 passive_fee;
        if (passive_shares > 0) {
            order_id = _genOrderId(packed_price, isAsk);
            uint64 trader_id = _getOrCreateTraderId(order_owner);
            uint128 total_value = passive_shares * price;
            passive_fee = _calculateTotalPassiveCommission(total_value);
            if (isAsk) {
                askTrie.addOrder(trader_id, order_id, passive_shares, total_value);

                x_to_receive += passive_shares;
            } else {
                bidTrie.addOrder(trader_id, order_id, passive_shares, total_value);
                // Orders with an order_id ending in 1 are asks, and those ending in 0 are bids.
                order_id ^= 0x1;

                y_to_receive += total_value + passive_fee;
            }
            execution_result.order_id = order_id;
        }

        require(passive_fee + aggressive_fee <= max_commission, Errors.MaxCommissionFailure());

        emit OrderPlaced(
            order_owner,
            msg.sender,
            order_id,
            isAsk,
            quantity,
            price,
            passive_shares,
            passive_fee,
            executed_shares,
            executed_value,
            aggressive_fee,
            market_only,
            post_only
        );

        // actual token transfer
        _handleTokenTransfer(
            order_owner,
            transfer_executed_tokens,
            x_to_send,
            x_to_receive,
            y_to_send,
            y_to_receive,
            withdraw_as_native_eth
        );
    }

    /// @notice Change market maker address and should invoke on trade flag
    /// @param _marketmaker New market maker address
    /// @param _should_invoke_on_trade Flag indicating that the market maker must implement ITradeConsumer
    function _changeMarketMaker(address _marketmaker, bool _should_invoke_on_trade) internal {
        if (_should_invoke_on_trade) {
            IERC165 maker = IERC165(_marketmaker);
            if (!maker.supportsInterface(type(ITradeConsumer).interfaceId)) {
                revert Errors.InvalidMarketMaker();
            }
        }

        require(_marketmaker != address(0), Errors.AddressIsZero());

        marketMakerConfig =
            MarketMakerConfig({ marketmaker: _marketmaker, should_invoke_on_trade: _should_invoke_on_trade });
    }

    /// @notice Transfers the accumulated commissions to the fees_receiver and marketmaker.
    function _transferFees() internal {
        uint256 total_fees = (accumulated_fees - 1) / wad;
        accumulated_fees -= total_fees * wad;

        if (total_fees == 0) {
            return;
        }

        uint256 admin_fees = total_fees.mulWadUp(admin_commission_rate);

        uint256 marketmaker_fees = total_fees - admin_fees;
        if (marketmaker_fees > 0) {
            traderBalances[marketMakerConfig.marketmaker].token_y += marketmaker_fees.toUint128();
        }

        uint256 actual_token_y_to_send = _convertToActualTokenYAmount(admin_fees.toUint128());
        if (actual_token_y_to_send > 0) {
            token_y.safeTransfer(feesReceiver, actual_token_y_to_send);
        }
    }

    /// @notice Retrieves or creates a trader ID for a given address.
    /// @param trader_address The address of the trader for whom the ID is to be retrieved or created.
    /// @return trader_id The trader ID associated with the given address.
    function _getOrCreateTraderId(address trader_address) internal returns (uint64 trader_id) {
        trader_id = traders[trader_address].trader_id;
        if (trader_id == 0) {
            // initialize a new Trader structure
            trader_id = ++last_used_trader_id;

            traders[trader_address].trader_id = trader_id;
            traders[trader_address].claimable = true;
            traders[trader_address].transfer_tokens = true;
            traders[trader_address].withdraw_as_native_eth = true;
        }
    }

    /// @notice Calculates and transfers the total fees and payout.
    /// @param executed_value The value of the executed order.
    /// @return The total aggressive fees calculated and transferred.
    function _calculateAndTransferTotalAggressiveFeesAndPayout(uint128 executed_value) internal returns (uint128) {
        if (executed_value == 0) {
            return 0;
        }

        uint128 total_fees_and_payout_rate = total_aggressive_commission_rate + passive_order_payout_rate;
        if (total_fees_and_payout_rate == 0) {
            return 0;
        }

        uint256 total_aggressive_fees_and_payout = uint256(executed_value).mulWadUp(total_fees_and_payout_rate);

        accumulated_fees += (
            total_aggressive_fees_and_payout * wad - executed_value * uint256(passive_order_payout_rate)
                + executed_value * uint256(total_passive_commission_rate)
        );

        return total_aggressive_fees_and_payout.toUint128();
    }

    /// @notice Calculates the total passive commission for a given value.
    /// @param total_value The total value for which the passive commission is to be calculated.
    /// @return The total passive commission calculated.
    function _calculateTotalPassiveCommission(uint128 total_value) internal view returns (uint128) {
        if (total_passive_commission_rate == 0) {
            return 0;
        }
        uint256 total_passive_commissions = uint256(total_value).mulWadUp(total_passive_commission_rate);
        return total_passive_commissions.toUint128();
    }

    /// @notice Calculates the passive order payout or refunded commissions based on the remaining shares.
    /// @param isAsk A boolean flag indicating whether the order is an ask (true) or a bid (false).
    /// @param price The price of the order.
    /// @param remain_shares The remaining shares of the order.
    /// @param total_shares The total shares of the order.
    /// @return refund_value The calculated passive payout or refunded commissions.
    /// @return fee_rounding_error The rounding error in the fee calculation.
    function _calculatePassiveOrderPayoutOrRefundedCommissions(
        bool isAsk,
        uint72 price,
        uint128 remain_shares,
        uint128 total_shares
    ) internal view returns (uint128 refund_value, uint256 fee_rounding_error) {
        if (passive_order_payout_rate > 0) {
            uint256 executed_value = price * (total_shares - remain_shares);
            uint256 passive_payout = executed_value.mulWadDown(passive_order_payout_rate);
            refund_value = passive_payout.toUint128();
            fee_rounding_error = executed_value * passive_order_payout_rate - refund_value * wad;
        } else {
            // Refunding part of the passive commission.
            uint128 executed_value = price * (total_shares - remain_shares);
            uint256 executed_fees = _calculateTotalPassiveCommission(executed_value);
            fee_rounding_error = executed_fees * wad - executed_value * total_passive_commission_rate;

            if (!isAsk) {
                uint128 total_value = price * total_shares;
                uint128 total_fees = _calculateTotalPassiveCommission(total_value);
                refund_value = total_fees - executed_fees.toUint128();
            }
        }
    }

    /// @notice Decrements the nonce and returns the new value, reverts if nonce reaches zero.
    /// @dev This function is used to ensure unique order identifiers by decrementing the nonce.
    ///      If the nonce reaches zero, the function will revert to prevent identifier collisions.
    /// @return c_nonce The decremented nonce value.
    function _getAndUpdateNonce() internal returns (uint64 c_nonce) {
        c_nonce = nonce;
        unchecked {
            nonce -= 1;
        }
        require(nonce > 0, Errors.NonceExhaustedFailure());
    }

    /// @notice Generates a unique price identifier based on the given price and order type.
    /// @param packed_price The FP2 price of the order.
    /// @param isAsk A boolean indicating whether the order is an ask (true) or a bid (false).
    /// @return price_id The generated unique identifier for the price.
    function _genPriceId(uint24 packed_price, bool isAsk) internal pure returns (uint64 price_id) {
        if (isAsk) {
            price_id = uint64(packed_price) << nonce_length;
        } else {
            uint64 max_price = type(uint24).max;
            unchecked {
                price_id = (max_price - packed_price) << nonce_length;
            }
        }
        price_id = price_id << 1 ^ 0x1;
    }

    /// @notice Generates a unique order identifier based on the price and order type.
    /// @param packed_price The FP24 price of the order.
    /// @param isAsk A boolean indicating whether the order is an ask (true) or a bid (false).
    /// @return order_id The generated unique identifier for the order.
    function _genOrderId(uint24 packed_price, bool isAsk) internal returns (uint64 order_id) {
        uint64 c_nonce = _getAndUpdateNonce();
        if (isAsk) {
            unchecked {
                order_id = ((uint64(type(uint24).max - packed_price) << nonce_length) | c_nonce);
            }
        } else {
            order_id = ((uint64(packed_price) << nonce_length) | c_nonce);
        }
        order_id = order_id << 1 ^ 0x1;
    }

    /// @notice Converts the amount of token X from a simplified representation to the actual ERC20 amount.
    /// @dev Multiplies the amount of token X by the scaling factor to obtain the actual amount.
    /// @param token The amount of token X in a simplified representation.
    /// @return Returns the actual amount of token X after scaling.
    function _convertToActualTokenXAmount(uint128 token) internal view returns (uint256) {
        return token * scaling_factor_token_x;
    }

    /// @notice Converts the amount of token Y from a simplified representation to the actual ERC20 amount.
    /// @dev Multiplies the amount of token Y by the scaling factor to obtain the actual amount.
    /// @param token The amount of token Y in a simplified representation.
    /// @return Returns the actual amount of token Y after scaling.
    function _convertToActualTokenYAmount(uint128 token) internal view returns (uint256) {
        return token * scaling_factor_token_y;
    }

    /// @dev Handles the transfer of tokens during the execution or claiming/cancelling of an order.
    /// @param client The address of the trader executing the order.
    /// @param transfer_tokens A boolean flag indicating whether to transfer the tokens immediately.
    /// @param x_to_send The amount of token X to send.
    /// @param x_to_receive The amount of token X to receive.
    /// @param y_to_send The amount of token Y to send.
    /// @param y_to_receive The amount of token Y to receive.
    /// @param withdraw_as_native_eth Flag for withdrawing as native ETH (true) or as ERC20 tokens (false)
    function _handleTokenTransfer(
        address client,
        bool transfer_tokens,
        uint128 x_to_send,
        uint128 x_to_receive,
        uint128 y_to_send,
        uint128 y_to_receive,
        bool withdraw_as_native_eth
    ) internal {
        uint256 actual_token_x_to_send = 0;
        uint256 actual_token_x_to_receive = 0;

        uint256 actual_token_y_to_send = 0;
        uint256 actual_token_y_to_receive = 0;

        IWETH weth = is_token_x_weth ? IWETH(address(token_x)) : IWETH(address(token_y));

        if (supports_native_eth && !withdraw_as_native_eth && address(this).balance > 0) {
            weth.deposit{ value: address(this).balance }();
        }

        if (msg.value > 0) {
            if (is_token_x_weth) {
                uint128 extra_x = (msg.value / scaling_factor_token_x).toUint128();
                uint256 actual_value = _convertToActualTokenXAmount(extra_x);

                x_to_send += extra_x;

                uint256 rounded_value = msg.value - actual_value;
                actual_token_x_to_send = rounded_value;
            } else {
                uint128 extra_y = (msg.value / scaling_factor_token_y).toUint128();
                uint256 actual_value = _convertToActualTokenYAmount(extra_y);

                y_to_send += extra_y;

                uint256 rounded_value = msg.value - actual_value;
                actual_token_y_to_send = rounded_value;
            }
        }

        // processing token_x
        if (x_to_send > x_to_receive) {
            uint128 shares_to_send;
            unchecked {
                shares_to_send = x_to_send - x_to_receive;
            }
            if (transfer_tokens) {
                actual_token_x_to_send += _convertToActualTokenXAmount(shares_to_send);
            } else {
                traderBalances[client].token_x += shares_to_send;
                emit Deposited(client, shares_to_send, 0);
            }
        } else if (x_to_send < x_to_receive) {
            uint128 shares_to_receive;
            unchecked {
                shares_to_receive = x_to_receive - x_to_send;
            }
            uint128 clients_shares = traderBalances[msg.sender].token_x;
            if (clients_shares >= shares_to_receive) {
                unchecked {
                    traderBalances[msg.sender].token_x -= shares_to_receive;
                }
                emit Withdrawn(msg.sender, shares_to_receive, 0);
            } else {
                unchecked {
                    shares_to_receive -= clients_shares;
                }
                actual_token_x_to_receive = _convertToActualTokenXAmount(shares_to_receive);

                traderBalances[msg.sender].token_x = 0;
                emit Withdrawn(msg.sender, clients_shares, 0);
            }
        }

        // processing token_y
        if (y_to_send > y_to_receive) {
            uint128 value_to_send;
            unchecked {
                value_to_send = y_to_send - y_to_receive;
            }
            if (transfer_tokens) {
                actual_token_y_to_send += _convertToActualTokenYAmount(value_to_send);
            } else {
                traderBalances[client].token_y += value_to_send;
                emit Deposited(client, 0, value_to_send);
            }
        } else if (y_to_send < y_to_receive) {
            uint128 value_to_receive;
            unchecked {
                value_to_receive = y_to_receive - y_to_send;
            }
            uint128 clients_value = traderBalances[msg.sender].token_y;
            if (clients_value >= value_to_receive) {
                unchecked {
                    traderBalances[msg.sender].token_y -= value_to_receive;
                }
                emit Withdrawn(msg.sender, 0, value_to_receive);
            } else {
                unchecked {
                    value_to_receive -= clients_value;
                }
                actual_token_y_to_receive = _convertToActualTokenYAmount(value_to_receive);

                traderBalances[msg.sender].token_y = 0;
                emit Withdrawn(msg.sender, 0, clients_value);
            }
        }

        // Withdrawing WETH
        if (supports_native_eth && withdraw_as_native_eth) {
            uint256 value_to_withdraw;

            if (is_token_x_weth && (actual_token_x_to_send > address(this).balance)) {
                value_to_withdraw = actual_token_x_to_send - address(this).balance;
            }

            if (!is_token_x_weth && (actual_token_y_to_send > address(this).balance)) {
                value_to_withdraw = actual_token_y_to_send - address(this).balance;
            }

            if (value_to_withdraw > 0) {
                weth.withdraw(value_to_withdraw);
            }
        }

        // actual erc20 transactions
        if (actual_token_x_to_send > 0) {
            if (supports_native_eth && is_token_x_weth) {
                if (withdraw_as_native_eth) {
                    _sendETH(client, actual_token_x_to_send);
                } else {
                    token_x.safeTransfer(client, actual_token_x_to_send);
                }
            } else {
                token_x.safeTransfer(client, actual_token_x_to_send);
            }
        }
        if (actual_token_x_to_receive > 0) {
            _safeTransferFromWithBalanceCheck(token_x, msg.sender, actual_token_x_to_receive);
        }
        if (actual_token_y_to_send > 0) {
            if (supports_native_eth && !is_token_x_weth) {
                if (withdraw_as_native_eth) {
                    _sendETH(client, actual_token_y_to_send);
                } else {
                    token_y.safeTransfer(client, actual_token_y_to_send);
                }
            } else {
                token_y.safeTransfer(client, actual_token_y_to_send);
            }
        }
        if (actual_token_y_to_receive > 0) {
            _safeTransferFromWithBalanceCheck(token_y, msg.sender, actual_token_y_to_receive);
        }

        // Depositing WETH
        if (supports_native_eth && (address(this).balance > 0)) {
            weth.deposit{ value: address(this).balance }();
        }
    }

    /// @dev Transfer tokens into CLOB balance safely with balance check
    /// @param token Token contract
    /// @param from The address from which tokens are sent
    /// @param value Amount of tokens
    function _safeTransferFromWithBalanceCheck(IERC20 token, address from, uint256 value) internal {
        uint256 balance_before = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), value);
        uint256 balance_after = token.balanceOf(address(this));
        require(balance_after - balance_before == value, Errors.InvalidTransfer());
    }

    /// @notice Sends ETH to the specified address
    /// @dev Uses a low-level call to send ETH, which allows bypassing the 2300 gas limit imposed by transfer function
    /// @param to The recipient address for ETH
    /// @param value The amount of ETH to send (in wei)
    function _sendETH(address to, uint256 value) internal {
        (bool success,) = to.call{ value: value }("");
        require(success, Errors.TransferFailed());
    }

    /// @dev Invoke TradeConsumer onTrade callback if executed shares are greater than zero, msg.sender is not
    /// market maker and should_invoke_on_trade is true
    /// @param executed_shares Executed shares
    /// @param isAsk A boolean indicating whether the order is an ask (true) or a bid (false)
    function _invokeTradeConsumerCallback(uint128 executed_shares, bool isAsk) internal {
        if (executed_shares == 0) {
            return;
        }

        if (marketMakerConfig.should_invoke_on_trade && msg.sender != marketMakerConfig.marketmaker) {
            ITradeConsumer(marketMakerConfig.marketmaker).onTrade(isAsk);
        }
    }

    /// @dev Updates bid/ask consumer with current the first level prices from order book
    function _updateBidAskConsumer() internal {
        if (address(bidAskConsumer) == address(0)) {
            return;
        }

        uint64 bid_best_offer = bidTrie.best_offer();
        uint24 bid = uint24(bid_best_offer >> 40);

        uint64 ask_best_offer = askTrie.best_offer();
        uint24 ask = ask_best_offer != 0 ? type(uint24).max - uint24(ask_best_offer >> 40) : 0;

        try bidAskConsumer.setBidAsk(bid, ask) { } catch { }
    }

    /// @dev Get the revert message from the return data of a failed transaction
    /// @param returnData The return data of the failed transaction
    /// @return The revert message
    function _getRevertMsg(bytes memory returnData) internal pure returns (string memory) {
        if (returnData.length < 68) {
            return "Transaction reverted silently";
        }

        bytes memory sliced = new bytes(returnData.length - 4);
        for (uint256 i = 4; i < returnData.length; i++) {
            sliced[i - 4] = returnData[i];
        }

        return abi.decode(sliced, (string));
    }
}
