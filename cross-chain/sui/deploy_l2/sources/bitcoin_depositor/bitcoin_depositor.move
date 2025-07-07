// SPDX-License-Identifier: GPL-3.0-only

module l2_tbtc::BitcoinDepositor {

    use l2_tbtc::Gateway;
    use l2_tbtc::TBTC;
    use sui::clock::Clock;
    use sui::event;
    use sui::table::{Self, Table};
    use wormhole::bytes32;
    use wormhole::external_address::{Self, ExternalAddress};
    use wormhole::state::State as WormholeState;
    use wormhole::vaa;

    // === Constants ===

    const EMITTER_CHAIN_L1: u16 = 2;

    // === Error codes ===

    const INVALID_CHAIN_ID: u64 = 0;
    const INVALID_SENDER: u64 = 1;
    const MESSAGE_ALREADY_PROCESSED: u64 = 2;

     // === Events ===

    public struct MessageProcessed has copy, drop {
        vaa_hash: vector<u8>,
    }

    /// Event which is emitted as a initialization of the bitcoin deposit
    public struct DepositInitialized has copy, drop {
        funding_tx: vector<u8>,
        deposit_reveal: vector<u8>,
        deposit_owner: vector<u8>,
        sender: vector<u8>,
    }

    // === Types ===

    /// Object to store state
    public struct ReceiverState has key {
        id: UID,
        // Store processed VAA hashes to prevent replay attacks
        processed_vaas: Table<vector<u8>, bool>,
        // Address of our contract on ETH side
        trusted_emitter: ExternalAddress,
    }

    /// Admin capabilities
    public struct AdminCap has key, store {
        id: UID,
    }

    /// Initialize the receiver contract
    fun init(ctx: &mut TxContext) {
        // Create a dummy external address for initialization
        // This should be properly set by the admin later
        let mut empty_address = vector::empty<u8>();
        vector::append(
            &mut empty_address,
            x"0000000000000000000000000000000000000000000000000000000000000000",
        );
        let sender = tx_context::sender(ctx);

        let state = ReceiverState {
            id: object::new(ctx),
            processed_vaas: table::new(ctx),
            trusted_emitter: external_address::new(bytes32::new(empty_address)),
        };

        // Create and share the admin capability
        let admin_cap = AdminCap {
            id: object::new(ctx),
        };

        transfer::transfer(admin_cap, sender);
        transfer::share_object(state);
    }

    /// Admin function to set trusted emitter (the address of L1 BitcoinDepositor)
    /// This should be called after deployment to set the correct address
    /// emitter -  Wormhole External Address of L1 BitcoinDepositor
    /// ctx - Transaction context
    /// Requires AdminCap
    public entry fun set_trusted_emitter(
        _: &AdminCap,
        state: &mut ReceiverState,
        emitter: vector<u8>,
        _ctx: &mut TxContext,
    ) {
        state.trusted_emitter = external_address::new(bytes32::new(emitter));
    }

    /// Initialize a deposit
    /// funding_tx Bitcoin funding transaction data.
    /// deposit_reveal Deposit reveal data.
    /// deposit_owner Address of the L2 deposit owner.
    public entry fun initialize_deposit(
        funding_tx: vector<u8>,
        deposit_reveal: vector<u8>,
        deposit_owner: vector<u8>,
        ctx: &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        // Emit event for successful processing
        event::emit(DepositInitialized {
            funding_tx,
            deposit_reveal,
            deposit_owner,
            sender: external_address::to_bytes(
                external_address::new(bytes32::new(sui::address::to_bytes(sender))),
            ),
        });
    }

    /// Function to process incoming Wormhole VAAs
    /// receiver_state - State of the receiver contract
    /// gateway_state - State of the gateway contract
    /// capabilities - Gateway capabilities
    /// treasury - Wrapped token treasury
    /// wormhole_state - Wormhole state
    /// token_bridge_state - Token bridge state
    /// token_state - Token state
    /// vaa_bytes - Raw VAA bytes
    /// clock - Clock
    /// ctx - Transaction context
    public entry fun receiveWormholeMessages<CoinType>(
        receiver_state: &mut ReceiverState,
        gateway_state: &mut Gateway::GatewayState,
        capabilities: &mut Gateway::GatewayCapabilities,
        treasury: &mut Gateway::WrappedTokenTreasury<CoinType>,
        wormhole_state: &mut WormholeState,
        token_bridge_state: &mut token_bridge::state::State,
        token_state: &mut TBTC::TokenState,
        vaa_bytes: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        // Parse and verify the VAA
        let parsed_vaa = vaa::parse_and_verify(wormhole_state, vaa_bytes, clock);

        // Get the VAA digest (hash)
        let vaa_hash = vaa::digest(&parsed_vaa);
        let digest_bytes = bytes32::to_bytes(vaa_hash);

        // Verify this VAA hasn't been processed before
        assert!(
            !table::contains(&receiver_state.processed_vaas, digest_bytes),
            MESSAGE_ALREADY_PROCESSED,
        );

        // Verify the emitter chain and address
        let (emitter_chain, emitter_address, _) = vaa::take_emitter_info_and_payload(parsed_vaa);

        assert!(emitter_chain == EMITTER_CHAIN_L1, INVALID_CHAIN_ID);
        assert!(
            external_address::to_bytes32(emitter_address)
                    == external_address::to_bytes32(receiver_state.trusted_emitter),
            INVALID_SENDER,
        );

        // Mark this VAA as processed
        table::add(&mut receiver_state.processed_vaas, digest_bytes, true);

        // Emit event for successful processing
        event::emit(MessageProcessed {
            vaa_hash: digest_bytes,
        });

        // Call the gateway contract to redeem tokens
        Gateway::redeem_tokens(
            gateway_state,
            capabilities,
            wormhole_state,
            treasury,
            token_bridge_state,
            token_state,
            vaa_bytes,
            clock,
            ctx,
        )
    }

    /// For testing purposes only
    #[test_only]
    public fun init_test(ctx: &mut TxContext) {
         let mut empty_address = vector::empty<u8>();
        vector::append(
            &mut empty_address,
            x"0000000000000000000000000000000000000000000000000000000000000000",
        );
        let sender = tx_context::sender(ctx);

        let state = ReceiverState {
            id: object::new(ctx),
            processed_vaas: table::new(ctx),
            trusted_emitter: external_address::new(bytes32::new(empty_address)),
        };

        // Create and share the admin capability
        let admin_cap = AdminCap {
            id: object::new(ctx),
        };

        transfer::transfer(admin_cap, sender);
        transfer::share_object(state);
    }
}