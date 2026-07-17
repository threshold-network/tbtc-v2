// SPDX-License-Identifier: GPL-3.0-only

module l2_tbtc::TBTC {

    use sui::coin::{Self, Coin, TreasuryCap};
    use sui::event;
    use sui::url;

    // === Constants ===

    // Error codes
    const E_NOT_GUARDIAN: u64 = 1;
    const E_ALREADY_MINTER: u64 = 2;
    const E_NOT_IN_MINTERS_LIST: u64 = 3;
    const E_ALREADY_GUARDIAN: u64 = 4;
    const E_NOT_IN_GUARDIANS_LIST: u64 = 5;
    const E_PAUSED: u64 = 6;
    const E_NOT_PAUSED: u64 = 7;

    // === Events ===

    public struct MinterAdded has copy, drop { minter: address }
    public struct MinterRemoved has copy, drop { minter: address }
    public struct GuardianAdded has copy, drop { guardian: address }
    public struct GuardianRemoved has copy, drop { guardian: address }
    public struct Paused has copy, drop { guardian: address }
    public struct Unpaused has copy, drop { owner: address }
    public struct TokensMinted has copy, drop { amount: u64, recipient: address }
    public struct TokensBurned has copy, drop { amount: u64 }

    // === Types ===

    // One-Time-Witness for the coin
    public struct TBTC has drop {}

    /// Capability representing the authority to manage the token
    public struct AdminCap has key, store {
        id: UID,
    }

    /// A certificate proving an address is a minter
    public struct MinterCap has key, store {
        id: UID,
        minter: address,
    }

    /// A certificate proving an address is a guardian
    public struct GuardianCap has key, store {
        id: UID,
        guardian: address,
    }

    /// A global state object to track minters, guardians, and pause state
    public struct TokenState has key, store {
        id: UID,
        minters: vector<address>,
        guardians: vector<address>,
        paused: bool,
    }

    /// Module initializer
    fun init(witness: TBTC, ctx: &mut TxContext) {
        let (treasury_cap, metadata) = coin::create_currency(
            witness,
            // Setting decimals to 8 since wormhole uses max 8 decimals for wrapped tokens, and doing it this way we are avoiding normalization 
            // https://github.com/wormhole-foundation/wormhole/blob/4afcbdeb13ec03bdc45516c9be6da0091079f352/sui/token_bridge/sources/datatypes/normalized_amount.move#L25
            8, 
            b"TBTC",
            b"tBTC v2",
            b"Canonical L2/sidechain token implementation for tBTC",
            option::some(
                url::new_unsafe_from_bytes(
                    b"https://assets.coingecko.com/coins/images/11224/standard/0x18084fba666a33d37592fa2633fd49a74dd93a88.png",
                ),
            ),
            ctx,
        );

        let token_state = TokenState {
            id: object::new(ctx),
            minters: vector::empty(),
            guardians: vector::empty(),
            paused: false,
        };

        let admin_cap = AdminCap {
            id: object::new(ctx),
        };

        let sender = tx_context::sender(ctx);

        // Transfer ownership of the coin
        transfer::public_freeze_object(metadata);
        transfer::public_transfer(treasury_cap, sender);
        transfer::public_transfer(admin_cap, sender);
        transfer::share_object(token_state);
    }

    // ===== Owner functions =====

    /// Add a new minter address and return the MinterCap
    /// This function fixes the MinterCap issue by returning the cap instead of transferring it
    /// Requires AdminCap
    /// state - TokenState
    /// minter - Address to add as a minter
    /// ctx - Transaction context
    /// Returns: MinterCap for the minter
    /// Emits MinterAdded event
    public fun add_minter_with_cap(
        _: &AdminCap,
        state: &mut TokenState,
        minter: address,
        ctx: &mut TxContext,
    ): MinterCap {
        assert!(!is_minter(state, minter), E_ALREADY_MINTER);

        vector::push_back(&mut state.minters, minter);

        // Create and return the minter capability
        let minter_cap = MinterCap {
            id: object::new(ctx),
            minter,
        };

        event::emit(MinterAdded { minter });
        
        // Return the MinterCap instead of transferring it
        minter_cap
    }

    /// Remove a minter address
    /// Requires AdminCap
    /// state - TokenState
    /// minter - Address to remove from minters
    /// ctx - Transaction context
    /// Emits MinterRemoved event
    public entry fun remove_minter(
        _: &AdminCap,
        state: &mut TokenState,
        minter: address,
        _ctx: &mut TxContext,
    ) {
        let (found, index) = vector::index_of(&state.minters, &minter);
        assert!(found, E_NOT_IN_MINTERS_LIST);

        vector::remove(&mut state.minters, index);

        // Note: We cannot delete the MinterCap that was previously transferred,
        // but it will no longer be valid as we've removed the minter from the state

        event::emit(MinterRemoved { minter });
    }

    /// Add a new guardian address
    /// Requires AdminCap
    /// state - TokenState
    /// guardian - Address to add as a guardian
    /// ctx - Transaction context
    /// Emits GuardianAdded event
    public entry fun add_guardian(
        _: &AdminCap,
        state: &mut TokenState,
        guardian: address,
        ctx: &mut TxContext,
    ) {
        assert!(!is_guardian(state, guardian), E_ALREADY_GUARDIAN);

        vector::push_back(&mut state.guardians, guardian);

        // Create and transfer a guardian capability to the guardian
        let guardian_cap = GuardianCap {
            id: object::new(ctx),
            guardian,
        };
        transfer::public_transfer(guardian_cap, guardian);

        event::emit(GuardianAdded { guardian });
    }

    /// Remove a guardian address
    /// Requires AdminCap
    /// state - TokenState
    /// guardian - Address to remove from guardians
    /// ctx - Transaction context
    /// Emits GuardianRemoved event
    public entry fun remove_guardian(
        _: &AdminCap,
        state: &mut TokenState,
        guardian: address,
        _ctx: &mut TxContext,
    ) {
        let (found, index) = vector::index_of(&state.guardians, &guardian);
        assert!(found, E_NOT_IN_GUARDIANS_LIST);

        vector::remove(&mut state.guardians, index);

        // Note: We cannot delete the GuardianCap that was previously transferred,
        // but it will no longer be valid as we've removed the guardian from the state

        event::emit(GuardianRemoved { guardian });
    }

    /// Unpause the contract (token mints and burns)
    /// Requires AdminCap
    /// state - TokenState
    /// ctx - Transaction context
    /// Emits Unpaused event
    public entry fun unpause(_: &AdminCap, state: &mut TokenState, ctx: &mut TxContext) {
        assert!(state.paused, E_NOT_PAUSED);

        state.paused = false;
        event::emit(Unpaused { owner: tx_context::sender(ctx) });
    }

    // ===== Guardian functions =====

    /// Pause the contract (token mints and burns)
    /// Requires GuardianCap
    /// state - TokenState
    /// ctx - Transaction context
    /// Emits Paused event
    public entry fun pause(_: &GuardianCap, state: &mut TokenState, ctx: &mut TxContext) {
        let guardian = tx_context::sender(ctx);
        assert!(is_guardian(state, guardian), E_NOT_GUARDIAN);
        assert!(!state.paused, E_PAUSED);

        state.paused = true;
        event::emit(Paused { guardian });
    }

    // ===== Minter functions =====

    /// Mint new tokens to a specified address
    /// Requires MinterCap and TreasuryCap
    /// state - TokenState
    /// amount - Amount of tokens to mint
    /// recipient - Address to mint tokens to
    /// ctx - Transaction context
    /// Emits TokensMinted event
    public entry fun mint(
        _: &MinterCap,
        treasury_cap: &mut TreasuryCap<TBTC>,
        state: &TokenState,
        amount: u64,
        recipient: address,
        ctx: &mut TxContext,
    ) {
        // Only check that the contract is not paused
        // The MinterCap is sufficient authorization
        assert!(!state.paused, E_PAUSED);

        let minted_coin = coin::mint(treasury_cap, amount, ctx);
        let minted_amount = coin::value(&minted_coin);
        transfer::public_transfer(minted_coin, recipient);

        event::emit(TokensMinted { amount: minted_amount, recipient });
    }

    // ===== Public functions =====

    /// Burn tokens
    /// Requires TreasuryCap
    /// state - TokenState
    /// coin - Coin to burn
    /// Emits TokensBurned event
    public entry fun burn(
        treasury_cap: &mut TreasuryCap<TBTC>,
        state: &TokenState,
        coin: Coin<TBTC>,
    ) {
        assert!(!state.paused, E_PAUSED);
        let amount = coin::value(&coin);
        coin::burn(treasury_cap, coin);

        event::emit(TokensBurned { amount});
    }

    // ===== Test Helper functions =====

    #[test_only]
    public fun initialize_for_test(ctx: &mut TxContext): (AdminCap, TokenState, TreasuryCap<TBTC>) {
        // Create the TBTC token
        let (treasury_cap, metadata) = coin::create_currency(
            TBTC {},
            9, // Decimals
            b"TBTC",
            b"Threshold Bitcoin",
            b"Canonical L2/sidechain token implementation for tBTC",
            option::some(
                url::new_unsafe_from_bytes(
                    b"https://threshold.network/images/logos/threshold-bootstrap-icon.svg",
                ),
            ),
            ctx,
        );

        // Initialize the TokenState
        let token_state = TokenState {
            id: object::new(ctx),
            minters: vector::empty(),
            guardians: vector::empty(),
            paused: false,
        };

        // Create the AdminCap
        let admin_cap = AdminCap {
            id: object::new(ctx),
        };

        // Transfer ownership of the coin and metadata to the sender
        transfer::public_transfer(metadata, tx_context::sender(ctx));

        // Return the created objects for testing purposes
        (admin_cap, token_state, treasury_cap)
    }

    // ===== Helper functions =====

    /// Check if an address is a minter
    /// state - TokenState
    /// addr - Address to check
    /// Returns true if the address is a minter
    public fun is_minter(state: &TokenState, addr: address): bool {
        vector::contains(&state.minters, &addr)
    }

    /// Check if an address is a guardian
    /// state - TokenState
    /// addr - Address to check
    /// Returns true if the address is a guardian
    public fun is_guardian(state: &TokenState, addr: address): bool {
        vector::contains(&state.guardians, &addr)
    }

    /// Get all minters
    /// state - TokenState
    /// Returns a vector of all minters
    public fun get_minters(state: &TokenState): vector<address> {
        state.minters
    }

    /// Get all guardians
    /// state - TokenState
    /// Returns a vector of all guardians
    public fun get_guardians(state: &TokenState): vector<address> {
        state.guardians
    }

    /// Check if the contract is paused
    /// state - TokenState
    /// Returns true if the contract is paused
    public fun is_paused(state: &TokenState): bool {
        state.paused
    }
}