// SPDX-License-Identifier: GPL-3.0-only

module l2_tbtc::Gateway {

    use l2_tbtc::TBTC;
    use l2_tbtc::helpers::{encode_address, parse_encoded_address};
    use sui::clock::Clock;
    use sui::coin::{Self, Coin, TreasuryCap};
    use sui::event;
    use sui::table::{Self, Table};
    use token_bridge::complete_transfer_with_payload;
    use token_bridge::state::verified_asset;
    use token_bridge::transfer_tokens_with_payload::{Self, prepare_transfer};
    use token_bridge::transfer_tokens;
    use token_bridge::transfer_with_payload;
    use token_bridge::vaa::verify_only_once;
    use wormhole::bytes32;
    use wormhole::emitter::{Self, EmitterCap};
    use wormhole::external_address::{Self, ExternalAddress};
    use wormhole::state::State as WormholeState;
    use wormhole::vaa;

    // === Constants ===

    const E_INVALID_CHAIN_ID: u64 = 0;
    const E_INVALID_SENDER: u64 = 1;
    const E_MESSAGE_ALREADY_PROCESSED: u64 = 2;
    const E_NOT_ENOUGH_TOKENS: u64 = 4;
    const E_ALREADY_INITIALIZED: u64 = 6;
    const E_NOT_INITIALIZED: u64 = 7;
    const E_PAUSED: u64 = 8;
    const E_NOT_PAUSED: u64 = 9;
    const E_WRONG_NONCE: u64 = 10;

    // === Events ===

    public struct EmitterRegistered has copy, drop { chain_id: u16, emitter: address }
    public struct Paused has copy, drop {}
    public struct Unpaused has copy, drop {}
    public struct MintingLimitUpdated has copy, drop { new_limit: u64 }
    public struct GatewayInitialized has copy, drop {
        admin: address,
    }
    public struct ReceiverRegistered has copy, drop { chain_id: u16, receiver: address }
    public struct EmitterRemoved has copy, drop { chain_id: u16 }
    public struct TokensRedeemed has copy, drop {
        vaa_hash: vector<u8>,
        token_amount: u64,
        recipient: address,
        token_address: address,
        minted: bool,
    }
    public struct TokensSent has copy, drop {
        sequence: u64,
        amount: u64,
        recipient_chain: u16,
        recipient: address,
        nonce: u32,
    }
    public struct AdminChanged has copy, drop {
        previous_admin: address,
        new_admin: address,
    }

    // === Types ===

    /// Object to store gateway state
    public struct GatewayState has key {
        id: UID,
        // Store processed VAA hashes to prevent replay attacks
        processed_vaas: Table<vector<u8>, bool>,
        // Trusted Emitters
        trusted_emitters: Table<u16, ExternalAddress>,
        // Trusted Receivers
        trusted_receivers: Table<u16, ExternalAddress>,
        // Minting limit (useful for testing phases)
        minting_limit: u64,
        // Amount of tokens minted by this gateway
        minted_amount: u64,
        // Track if the gateway has been initialized
        is_initialized: bool,
        // Paused state
        paused: bool,
        // Nonce
        nonce: u32,
    }

    /// Separate object to store capabilities
    public struct GatewayCapabilities has key {
        id: UID,
        // MinterCap
        minter_cap: TBTC::MinterCap,
        // EmitterCap
        emitter_cap: EmitterCap,
        // TreasuryCap
        treasury_cap: TreasuryCap<TBTC::TBTC>,
    }

    /// Admin capability
    public struct AdminCap has key {
        id: UID,
    }

    #[allow(lint(coin_field))]
    /// Treasury to store wrapped tokens
    public struct WrappedTokenTreasury<phantom CoinType> has key {
        id: UID,
        tokens: Coin<CoinType>,
    }

    // === Initialization ===

    /// Initialize the gateway contract with basic structure
    fun init(ctx: &mut TxContext) {
        // Create a dummy external address for initialization
        let mut empty_address: vector<u8> = vector::empty<u8>();

        vector::append(
            &mut empty_address,
            x"0000000000000000000000000000000000000000000000000000000000000000",
        );

        let sender = tx_context::sender(ctx);

        // Create and share the gateway state with minimal initialization
        let state = GatewayState {
            id: object::new(ctx),
            processed_vaas: table::new(ctx),
            trusted_emitters: table::new(ctx),
            trusted_receivers: table::new(ctx),
            minting_limit: 18446744073709551615, // u64::MAX
            minted_amount: 0,
            is_initialized: false,
            paused: false,
            nonce: 0,
        };

        // Create and share the admin capability
        let admin_cap = AdminCap {
            id: object::new(ctx),
        };

        // Share state object and transfer admin capability
        transfer::share_object(state);
        transfer::transfer(admin_cap, sender);
    }

    /// Admin function to initialize the gateway with all required capabilities
    /// Requires AdminCap
    /// state - Gateway state
    /// wormhole_state - Wormhole state
    /// minter_cap - TBTC minter capability
    /// treasury_cap - TBTC treasury capability
    /// ctx - Transaction context
    /// Emits GatewayInitialized event
    public entry fun initialize_gateway<CoinType>(
        _: &AdminCap,
        state: &mut GatewayState,
        wormhole_state: &WormholeState,
        minter_cap: TBTC::MinterCap,
        treasury_cap: TreasuryCap<TBTC::TBTC>,
        ctx: &mut TxContext,
    ) {
        // Verify the gateway hasn't been initialized yet
        assert!(!state.is_initialized, E_ALREADY_INITIALIZED);

        // Create emitter capability
        let emitter_cap = emitter::new(wormhole_state, ctx);

        // Create and share the capabilities object
        let capabilities = GatewayCapabilities {
            id: object::new(ctx),
            minter_cap,
            emitter_cap,
            treasury_cap,
        };

        // Mark the gateway as initialized
        state.is_initialized = true;

        // Share the capabilities object
        transfer::share_object(capabilities);

        init_treasury<CoinType>(ctx);

        // Emit initialization event
        event::emit(GatewayInitialized {
            admin: tx_context::sender(ctx),
        });
    }

    /// This function initializes the treasury object
    /// ctx - Transaction context
    /// It is used to store the wrapped tokens
    fun init_treasury<CoinType>(ctx: &mut TxContext) {
        let treasury = WrappedTokenTreasury {
            id: object::new(ctx),
            tokens: coin::zero<CoinType>(ctx),
        };
        transfer::share_object(treasury);
    }

    /// Admin function to add a trusted emitters
    /// Requires AdminCap
    /// state - Gateway state
    /// emitter_id - Chain ID of the emitter
    /// emitter - External Address of the emitter
    /// ctx - Transaction context
    /// Emits EmitterRegistered event
    public entry fun add_trusted_emitter(
        _: &AdminCap,
        state: &mut GatewayState,
        emitter_id: u16,
        emitter: vector<u8>,
        _ctx: &mut TxContext,
    ) {
         // Verify the gateway is initialized
        assert!(state.is_initialized, E_NOT_INITIALIZED);

        state.trusted_emitters.add(emitter_id, external_address::new(bytes32::new(emitter)));
        event::emit(EmitterRegistered {
            chain_id: emitter_id,
            emitter: external_address::to_address(external_address::new(bytes32::new(emitter))),
        });
    }

    /// Admin function to remove a trusted emitter
    /// Requires AdminCap
    /// state - Gateway state
    /// emitter_id - Chain ID of the emitter
    /// ctx - Transaction context
    /// Emits EmitterRemoved event
    public entry fun remove_trusted_emitter(
        _: &AdminCap,
        state: &mut GatewayState,
        emitter_id: u16,
        _ctx: &mut TxContext,
    ) {
         // Verify the gateway is initialized
        assert!(state.is_initialized, E_NOT_INITIALIZED); 

        state.trusted_emitters.remove(emitter_id);
        event::emit(EmitterRemoved { chain_id: emitter_id });
    }

    /// Admin function to add a trusted receiver
    /// Requires AdminCap
    /// state - Gateway state
    /// receiver_id - Chain ID of the receiver
    /// receiver - External Address of the receiver
    /// ctx - Transaction context
    /// Emits ReceiverRegistered event
    public entry fun add_trusted_receiver(
        _: &AdminCap,
        state: &mut GatewayState,
        receiver_id: u16,
        receiver: vector<u8>,
        _ctx: &mut TxContext,
    ) {
         // Verify the gateway is initialized
        assert!(state.is_initialized, E_NOT_INITIALIZED);

        state.trusted_receivers.add(receiver_id, external_address::new(bytes32::new(receiver)));
        event::emit(ReceiverRegistered {
            chain_id: receiver_id,
            receiver: external_address::to_address(external_address::new(bytes32::new(receiver))),
        });
    }

    /// Admin function to remove a trusted receiver
    /// Requires AdminCap
    /// state - Gateway state
    /// receiver_id - Chain ID of the receiver
    /// ctx - Transaction context
    /// Emits ReceiverUnregistered event
    public entry fun remove_trusted_receiver(
        _: &AdminCap,
        state: &mut GatewayState,
        receiver_id: u16,
        _ctx: &mut TxContext,
    ) {
        // Verify the gateway is initialized
        assert!(state.is_initialized, E_NOT_INITIALIZED);

        state.trusted_receivers.remove(receiver_id);
    }

    /// Admin function to pause the gateway
    /// Requires AdminCap
    /// state - Gateway state
    /// ctx - Transaction context
    /// Emits Paused event
    public entry fun pause(_: &AdminCap, state: &mut GatewayState, _ctx: &mut TxContext) {
        // Verify the gateway is initialized
        assert!(state.is_initialized, E_NOT_INITIALIZED);
        assert!(!state.paused, E_PAUSED);

        state.paused = true;
        event::emit(Paused {});
    }

    /// Admin function to unpause the gateway
    /// Requires AdminCap
    /// state - Gateway state
    /// ctx - Transaction context
    /// Emits Unpaused event
    public entry fun unpause(_: &AdminCap, state: &mut GatewayState, _ctx: &mut TxContext) {
        // Verify the gateway is initialized
        assert!(state.is_initialized, E_NOT_INITIALIZED);
        assert!(state.paused, E_NOT_PAUSED);

        state.paused = false;
        event::emit(Unpaused {});
    }

    /// Admin function to update minting limit
    /// Requires AdminCap
    /// state - Gateway state
    /// new_limit - New minting limit
    /// ctx - Transaction context
    /// Emits MintingLimitUpdated event
    public entry fun update_minting_limit(
        _: &AdminCap,
        state: &mut GatewayState,
        new_limit: u64,
        _ctx: &mut TxContext,
    ) {
        // Verify the gateway is initialized
        assert!(state.is_initialized, E_NOT_INITIALIZED);

        state.minting_limit = new_limit;
        event::emit(MintingLimitUpdated { new_limit });
    }

    /// Admin function to change admin
    /// Requires AdminCap
    /// admin_cap - Admin capability
    /// new_admin - New admin address
    /// ctx - Transaction context
    /// Emits AdminChanged event
    public entry fun change_admin(admin_cap: AdminCap, new_admin: address, ctx: &mut TxContext) {

        // Share the new admin capability
        transfer::transfer(admin_cap, new_admin);

        // Emit an event to track the admin change
        event::emit(AdminChanged {
            previous_admin: tx_context::sender(ctx),
            new_admin,
        });
    }

    /// Main function to redeem tokens from Wormhole VAAs
    /// This function is used to redeem tokens from Wormhole VAAs
    /// The tokens are minted and sent to the recipient
    /// The VAA is verified and processed only once
    /// The function emits an event for the transaction
    /// The function reverts if the gateway is not initialized, the VAA has been processed before, the emitter chain is not trusted, the emitter address is not trusted, the VAA is not verified, the minting limit is reached
    public entry fun redeem_tokens<CoinType>(
        state: &mut GatewayState,
        capabilities: &mut GatewayCapabilities,
        wormhole_state: &mut WormholeState,
        treasury: &mut WrappedTokenTreasury<CoinType>,
        token_bridge_state: &mut token_bridge::state::State,
        token_state: &mut TBTC::TokenState,
        vaa_bytes: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        // Check if contract is paused 
        assert!(!state.paused, E_PAUSED);

        // Verify the gateway is initialized
        assert!(state.is_initialized, E_NOT_INITIALIZED);

        // Parse and verify the VAA
        let verified_vaa = vaa::parse_and_verify(wormhole_state, vaa_bytes, clock);

        // Get the VAA digest (hash)
        let vaa_hash = vaa::digest(&verified_vaa);
        let digest_bytes = bytes32::to_bytes(vaa_hash);

        // Verify this VAA hasn't been processed before
        assert!(!table::contains(&state.processed_vaas, digest_bytes), E_MESSAGE_ALREADY_PROCESSED);
        let emitter_chain = verified_vaa.emitter_chain();
        let emitter_address = verified_vaa.emitter_address();

        // Verify the emitter chain and address from trusted_emitters table in state
        assert!(emitter_exists(state, emitter_chain), E_INVALID_CHAIN_ID);
        assert!(emitter_address == get_emitter(state,emitter_chain), E_INVALID_SENDER);

        // Verify the VAA only once to prevent replay attacks
        let msg = verify_only_once(token_bridge_state, verified_vaa);

        // Authorize the transfer
        let receipt: complete_transfer_with_payload::RedeemerReceipt<
            CoinType,
        > = complete_transfer_with_payload::authorize_transfer(token_bridge_state, msg, ctx);

        // Redeem the coins
        let (
            bridged_coins,
            parsed_transfer,
            _source_chain,
        ) = complete_transfer_with_payload::redeem_coin(&capabilities.emitter_cap, receipt);

        // Extract the additional payload from the TransferWithPayload struct
        let additional_payload = transfer_with_payload::take_payload(parsed_transfer);

        // Parse our custom payload format to get the recipient address
        let recipient = parse_encoded_address(&additional_payload);

        // Get the amount of tokens to mint
        let amount = coin::value(&bridged_coins);

        // Mark this VAA as processed
        table::add(&mut state.processed_vaas, digest_bytes, true);

        // Check if we can mint new tokens or need to send the wrapped assets
        if (state.minted_amount + amount <= state.minting_limit) {
            // Within the limit, mint new tokens
            state.minted_amount = state.minted_amount + amount;

            // Mint TBTC tokens
            TBTC::mint(
                &capabilities.minter_cap,
                &mut capabilities.treasury_cap,
                token_state,
                amount,
                recipient,
                ctx,
            );

            // Emit event for successful processing
            event::emit(TokensRedeemed {
                vaa_hash: digest_bytes,
                token_amount: amount,
                recipient,
                token_address: @l2_tbtc,
                minted: true,
            });

            // Keep the wrapped coins in the contract
            store_wrapped_coins<CoinType>(treasury, bridged_coins);
        } else {
            // We've hit the mint limit, send wrapped assets directly
            event::emit(TokensRedeemed {
                vaa_hash: digest_bytes,
                token_amount: amount,
                recipient,
                token_address: @l2_tbtc,
                minted: false,
            });

            // Transfer wrapped coins directly to the recipient
            transfer::public_transfer(bridged_coins, recipient);
        }
    }

    /// Send tokens to the token bridge
    /// This function is used to send tokens to the token bridge for further processing
    /// The tokens are sent to the token bridge and not directly to the recipient
    /// The recipient chain is the chain where the recipient is located and where we have a receiver registered
    /// The recipient is the wormhole's external address of the recipient so it can be parsed to the recipient address type on desired chain
    /// The nonce is used to prevent replay attacks
    /// The message fee is the fee to be paid for sending the message
    /// The clock is used to get the current time
    /// The context is used to get the sender of the transaction
    /// The function emits an event for the transaction
    /// The function reverts if the gateway is not initialized, is paused, the recipient chain is not trusted, the treasury does not have enough tokens, or the minted amount is not enough
    public entry fun send_tokens<CoinType>(
        state: &mut GatewayState,
        capabilities: &mut GatewayCapabilities,
        token_bridge_state: &mut token_bridge::state::State,
        token_state: &mut TBTC::TokenState,
        treasury: &mut WrappedTokenTreasury<CoinType>,
        wormhole_state: &mut WormholeState,
        recipient_chain: u16,
        recipient_address: vector<u8>,
        coins: Coin<TBTC::TBTC>,
        nonce: u32,
        message_fee: Coin<sui::sui::SUI>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        // Check gateway state
        assert!(state.is_initialized, E_NOT_INITIALIZED);
        assert!(!state.paused, E_PAUSED);

        // Check if the nonce is valid
        assert!(state.nonce + 1 == nonce, E_WRONG_NONCE);

        // Verify recipient chain has a trusted receiver
        assert!(receiver_exists(state, recipient_chain), E_INVALID_CHAIN_ID);

        // Get the amount of tokens to send
        let amount_l2btc = coins.balance().value();

        // Check if treasury has enough tokens
        let treasury_balance = coin::value(&treasury.tokens);
        // We are reverting if the treasury does not have enough tokens
        assert!(treasury_balance >= amount_l2btc, E_NOT_ENOUGH_TOKENS);

        // Burn the tokens from the treasury since they were minted when our gateway got the wrapped tokens in treasury and they are 1:1
        TBTC::burn(
            &mut capabilities.treasury_cap,
            token_state,
            coins,
        );

        // We now need to withdraw the equivalent amount of wrapped tokens from the treasury
        let wrapped_coins = coin::split(&mut treasury.tokens, amount_l2btc, ctx);

        // Update the minted amount in the state
        if (state.minted_amount >= amount_l2btc) {
            state.minted_amount = state.minted_amount - amount_l2btc;
        } else {
            // This should not happen, but just in case
            state.minted_amount = 0;
        };

        // Get the asset info from the token bridge
        let asset_info: token_bridge::token_registry::VerifiedAsset<CoinType> = verified_asset(
            token_bridge_state,
        );

        // Get the receiver address
        let receiver_address = get_receiver(state, recipient_chain);
        let receiver_address_bytes = external_address::to_bytes(receiver_address);

        // Prepare the transfer
        // The recipient is the receiver address since we are sending cannonical tokens to the token bridge and not directly to the recipient
        // The recipient chain is the chain where the recipient is located and where we have a receiver registered
        let (prepared_transfer, dust) = prepare_transfer(
            &capabilities.emitter_cap,
            asset_info,
            wrapped_coins,
            recipient_chain,
            receiver_address_bytes,
            encode_address(external_address::new(bytes32::new(recipient_address))),
            nonce,
        );

        // Destroy dust coins
        // Dust is the amount of tokens that are not enough to be transferred and therefore we are destroying them
        coin::destroy_zero(dust);

        // Prepare the message
        let prepared_msg = transfer_tokens_with_payload::transfer_tokens_with_payload(
            token_bridge_state,
            prepared_transfer,
        );

        // Publish the message to the Wormhole
        let sequence = wormhole::publish_message::publish_message(
            wormhole_state,
            message_fee,
            prepared_msg,
            clock,
        );

        // Increment the nonce
        increment_nonce(state);

        // Emit an event for the transaction
        event::emit(TokensSent {
            sequence,
            amount: amount_l2btc,
            recipient_chain,
            recipient: sui::address::from_bytes(recipient_address),
            nonce,
        });
    }

    /// Send wrapped tokens to the token bridge
    /// This function is used to send wrapped tokens to the token bridge for further processing
    /// The tokens are sent to the token bridge and and the redeemer is reciepient himself
    /// The recipient chain is the chain where the recipient is located and we do not mind for our gateway since the tokens are send to him directly
    /// The recipient is the wormhole's external address of the recipient so it can be parsed to the recipient address type on desired chain
    /// The nonce is used to prevent replay attacks
    /// The message fee is the fee to be paid for sending the message
    /// The clock is used to get the current time
    /// The context is used to get the sender of the transaction
    /// The function emits an event for the transaction
    /// The function reverts if the gateway is not initialized, is paused, the recipient chain is not trusted
    public entry fun send_wrapped_tokens<CoinType>(
        state: &mut GatewayState,
        capabilities: &mut GatewayCapabilities,
        token_bridge_state: &mut token_bridge::state::State,
        wormhole_state: &mut WormholeState,
        recipient_chain: u16,
        recipient_address: vector<u8>,
        coins: Coin<CoinType>,
        nonce: u32,
        message_fee: Coin<sui::sui::SUI>,
        clock: &Clock,
        _ctx: &mut TxContext,
    ) {
        // Check gateway state
        assert!(state.is_initialized, E_NOT_INITIALIZED);
        assert!(!state.paused, E_PAUSED);

        // Check if the nonce is valid
        assert!(state.nonce + 1 == nonce, E_WRONG_NONCE);

        // Verify recipient chain has a trusted receiver
        assert!(receiver_exists(state, recipient_chain), E_INVALID_CHAIN_ID);

        // Get the amount of tokens to send
        let amount_wrapped = coins.balance().value();

        // Get the asset info from the token bridge
        let asset_info: token_bridge::token_registry::VerifiedAsset<CoinType> = verified_asset(
            token_bridge_state,
        );

        // Get the receiver address
        let recipient_address_bytes = external_address::to_bytes(
            external_address::new(bytes32::new(recipient_address)),
        );

        // Prepare the transfer
        // We are setting the recipient as redeemer address since we are sending wrapped tokens directly
        let (prepared_transfer, dust) = prepare_transfer(
            &capabilities.emitter_cap,
            asset_info,
            coins,
            recipient_chain,
            recipient_address_bytes,
            encode_address(external_address::new(bytes32::new(recipient_address))),
            nonce,
        );

        // Destroy dust coins
        // Dust is the amount of tokens that are not enough to be transferred and therefore we are destroying them
        coin::destroy_zero(dust);

        // Prepare the message
        let prepared_msg = transfer_tokens_with_payload::transfer_tokens_with_payload(
            token_bridge_state,
            prepared_transfer,
        );

        // Publish the message to the Wormhole
        let sequence = wormhole::publish_message::publish_message(
            wormhole_state,
            message_fee,
            prepared_msg,
            clock,
        );

        // Increment the nonce
        increment_nonce(state);

        // Emit an event for the transaction
        event::emit(TokensSent {
            sequence,
            amount: amount_wrapped,
            recipient_chain,
            recipient: sui::address::from_bytes(recipient_address),
            nonce,
        });
    }

    /// Send tokens using standard transfer (without payload)
    /// This function allows direct withdrawal to user's L1 address without requiring a redeemer contract
    /// The tokens are sent directly to the recipient address on the target chain
    /// This is used for user-initiated withdrawals back to L1
    public entry fun send_tokens_standard<CoinType>(
        state: &mut GatewayState,
        capabilities: &mut GatewayCapabilities,
        token_bridge_state: &mut token_bridge::state::State,
        token_state: &mut TBTC::TokenState,
        treasury: &mut WrappedTokenTreasury<CoinType>,
        wormhole_state: &mut WormholeState,
        recipient_chain: u16,
        recipient_address: vector<u8>,
        coins: Coin<TBTC::TBTC>,
        relayer_fee: u64,
        nonce: u32,
        message_fee: Coin<sui::sui::SUI>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        // Check gateway state
        assert!(state.is_initialized, E_NOT_INITIALIZED);
        assert!(!state.paused, E_PAUSED);

        // Check if the nonce is valid
        assert!(state.nonce + 1 == nonce, E_WRONG_NONCE);

        // Get the amount of tokens to send
        let amount_l2btc = coins.balance().value();

        // Check if treasury has enough tokens
        let treasury_balance = coin::value(&treasury.tokens);
        assert!(treasury_balance >= amount_l2btc, E_NOT_ENOUGH_TOKENS);

        // Burn the canonical tBTC tokens
        TBTC::burn(
            &mut capabilities.treasury_cap,
            token_state,
            coins,
        );

        // Withdraw the equivalent amount of wrapped tokens from the treasury
        let wrapped_coins = coin::split(&mut treasury.tokens, amount_l2btc, ctx);

        // Update the minted amount in the state
        if (state.minted_amount >= amount_l2btc) {
            state.minted_amount = state.minted_amount - amount_l2btc;
        } else {
            state.minted_amount = 0;
        };

        // Get the asset info from the token bridge
        let asset_info: token_bridge::token_registry::VerifiedAsset<CoinType> = verified_asset(
            token_bridge_state,
        );

        // Prepare the standard transfer (without payload)
        let (transfer_ticket, dust) = transfer_tokens::prepare_transfer(
            asset_info,
            wrapped_coins,
            recipient_chain,
            recipient_address,
            relayer_fee,
            nonce,
        );

        // Destroy dust coins
        coin::destroy_zero(dust);

        // Execute the transfer
        let prepared_msg = transfer_tokens::transfer_tokens(
            token_bridge_state,
            transfer_ticket,
        );

        // Publish the message to Wormhole
        let sequence = wormhole::publish_message::publish_message(
            wormhole_state,
            message_fee,
            prepared_msg,
            clock,
        );

        // Increment the nonce
        increment_nonce(state);

        // Emit an event for the transaction
        event::emit(TokensSent {
            sequence,
            amount: amount_l2btc,
            recipient_chain,
            recipient: sui::address::from_bytes(recipient_address),
            nonce,
        });
    }

    /// Helper to check the current nonce
    public fun check_nonce(state: &GatewayState): u32 {
        // Check gateway state
        assert!(state.is_initialized, E_NOT_INITIALIZED);
        assert!(!state.paused, E_PAUSED);
        // Return the current nonce
        state.nonce
    }

    /// Helper function to increment the nonce
    /// state - GatewayState
    /// It is used to increment the nonce
    /// The nonce is used to prevent replay attacks
    /// The nonce is incremented by 1 if the current nonce is less than the max value of u32
    /// The nonce is reset to 0 if the current nonce is equal to the max value of u32
    /// The function reverts if the gateway is not initialized
    /// The function reverts if the gateway is paused
    /// The function reverts if the nonce is not valid
    fun increment_nonce(state: &mut GatewayState) {
        // Check gateway state
        assert!(state.is_initialized, E_NOT_INITIALIZED);
        assert!(!state.paused, E_PAUSED);

        // Check if nonce does not exeed the max value of u32
        if (state.nonce == 4_294_967_293u32) {
            // Reset the nonce to 0 
            state.nonce = 0;
        } else {
            // Increment the nonce
            state.nonce = state.nonce + 1;
        }
    }

    /// Helper function to check if an emitter exists
    /// gateway_state - GatewayState
    /// chain_id - Chain ID of the emitter
    /// Returns true if the emitter exists
    /// Returns false if the emitter does not exist
    public fun emitter_exists(gateway_state: &GatewayState, chain_id: u16): bool {
        gateway_state.trusted_emitters.contains(chain_id)
    }

    /// Helper function to get an emitter
    /// gateway_state - GatewayState
    /// chain_id - Chain ID of the emitter
    /// Returns the emitter address
    /// Reverts if the emitter does not exist
    public fun get_emitter(gateway_state: &GatewayState, chain_id: u16): ExternalAddress {
        *gateway_state.trusted_emitters.borrow(chain_id)
    }

    /// Helper function to check if a receiver exists
    /// gateway_state - GatewayState
    /// chain_id - Chain ID of the receiver
    /// Returns true if the receiver exists
    public fun receiver_exists(gateway_state: &GatewayState, chain_id: u16): bool {
        gateway_state.trusted_receivers.contains(chain_id)
    }

    /// Helper function to get a receiver
    /// gateway_state - GatewayState
    /// chain_id - Chain ID of the receiver
    /// Returns the receiver address
    public fun get_receiver(gateway_state: &GatewayState, chain_id: u16): ExternalAddress {
        *gateway_state.trusted_receivers.borrow(chain_id)
    }

    /// Helper function to get the initialized state
    /// gateway_state - GatewayState
    /// Returns true if the gateway is initialized
    /// Returns false if the gateway is not initialized
    public fun is_initialized(gateway_state: &GatewayState): bool {
        gateway_state.is_initialized
    }

    /// Helper function to get the paused state
    /// gateway_state - GatewayState
    /// Returns true if the gateway is paused
    /// Returns false if the gateway is not paused
    public fun is_paused(gateway_state: &GatewayState): bool {
        gateway_state.paused
    }

    /// Helper function to get the minting limit
    /// gateway_state - GatewayState
    /// Returns the minting limit
    public fun get_minting_limit(gateway_state: &GatewayState): u64 {
        gateway_state.minting_limit
    }

    /// Helper function to get the minted amount
    /// gateway_state - GatewayState
    /// Returns the minted amount
    public fun get_minted_amount(gateway_state: &GatewayState): u64 {
        gateway_state.minted_amount
    }

    /// Helper function to store wrapped coins in the treasury
    /// treasury - WrappedTokenTreasury
    /// coins - Coin
    /// It is used to store the wrapped tokens in the treasury
    fun store_wrapped_coins<CoinType>(
        treasury: &mut WrappedTokenTreasury<CoinType>,
        coins: Coin<CoinType>,
    ) {
        coin::join(&mut treasury.tokens, coins);
    }

    // // For testing purposes only
    #[test_only]
    public fun init_test(ctx: &mut TxContext) {
        let gateway_state = GatewayState {
            is_initialized: false,
            paused: false,
            minting_limit: 1000000000000000000,
            minted_amount: 0,
            processed_vaas: table::new(ctx),
            trusted_emitters: table::new(ctx),
            trusted_receivers: table::new(ctx),
            id: object::new(ctx),
            nonce: 0,
        };
        // Create and share the admin capability
        let admin_cap = AdminCap {
            id: object::new(ctx),
        };

        // Share state object and transfer admin capability
        transfer::transfer(admin_cap, ctx.sender());
        transfer::share_object(gateway_state);
    }

    /// Setter for nonce for testing purposes
    #[test_only]
    public fun set_nonce(state: &mut GatewayState, nonce: u32) {
        state.nonce = nonce;
    }

    #[test_only]
    public fun initialize_gateway_test<CoinType>( gateway_state: &mut GatewayState,  minter_cap: TBTC::MinterCap, treasury_cap: TreasuryCap<TBTC::TBTC>, ctx: &mut TxContext, emitter_cap: EmitterCap) {
     // Verify the gateway hasn't been initialized yet
        assert!(!gateway_state.is_initialized, E_ALREADY_INITIALIZED);

        // Create and share the capabilities object
        let capabilities = GatewayCapabilities {
            id: object::new(ctx),
            minter_cap,
            emitter_cap,
            treasury_cap,
        };

        // Mark the gateway as initialized
        gateway_state.is_initialized = true;

        // Share the capabilities object
        transfer::share_object(capabilities);

        init_treasury<CoinType>(ctx);

        // Emit initialization event
        event::emit(GatewayInitialized {
            admin: tx_context::sender(ctx),
        });
    }

    // get capability total supply
    #[test_only]
    public fun get_total_supply(capabilities: &mut GatewayCapabilities): u64 {
        capabilities.treasury_cap.total_supply()
    }
}
