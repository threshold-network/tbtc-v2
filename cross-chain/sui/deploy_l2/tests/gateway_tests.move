#[test_only]
module l2_tbtc::gateway_tests {

    use l2_tbtc::Gateway;
    use l2_tbtc::TBTC;
    use l2_tbtc::test_utils::message_with_payload_address;
    use sui::balance;
    use sui::clock;
    use sui::coin::{Self, TreasuryCap};
    use sui::sui::SUI;
    use sui::test_scenario;
    use token_bridge::coin_wrapped_12;
    use token_bridge::setup;
    use token_bridge::token_bridge_scenario::{
        register_dummy_emitter,
        set_up_wormhole_and_token_bridge,
        two_people,
        take_state as take_token_bridge_state,
        return_state as return_token_bridge_state
    };
    use wormhole::emitter::{Self, EmitterCap};
    use wormhole::wormhole_scenario::{
        return_state as return_wormhole_state,
        take_state as take_wormhole_state
    };

    // Helper function to initialize Wormhole for testing
    fun init_wormhole_for_test(scenario: &mut test_scenario::Scenario, deployer: address) {
        let expected_source_chain = 2;
        set_up_wormhole_and_token_bridge(scenario, 1);
        register_dummy_emitter(scenario, expected_source_chain);
        coin_wrapped_12::init_and_register(scenario, deployer);
    }

    fun init_tbtc_for_test_scenario(scenario: &mut test_scenario::Scenario, admin: address) {
        let (admin_cap, mut token_state, treasury_cap) = TBTC::initialize_for_test(
            test_scenario::ctx(scenario)
        );
        TBTC::add_minter(&admin_cap, &mut token_state, admin, test_scenario::ctx(scenario));
        transfer::public_transfer(token_state, admin);
        transfer::public_transfer(treasury_cap, admin);
        transfer::public_transfer(admin_cap, admin);
    }

    fun initialize_gateway_state(scenario: &mut test_scenario::Scenario) {
        let treasury_cap = test_scenario::take_from_sender<TreasuryCap<TBTC::TBTC>>(scenario);
        let minter_cap = test_scenario::take_from_sender<TBTC::MinterCap>(scenario);
        let gateway_admin_cap = test_scenario::take_from_sender<Gateway::AdminCap>(scenario);
        let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(scenario);
        let ctx = test_scenario::ctx(scenario);
        let emitter_cap: EmitterCap = emitter::dummy();

        // Initialize gateway with wrapped token type
        Gateway::initialize_gateway_test<coin_wrapped_12::COIN_WRAPPED_12>(
            &mut gateway_state,
            minter_cap,
            treasury_cap,
            ctx,
            emitter_cap,
        );

        // Verify initialization by trying to add a trusted emitter
        let emitter_id = 2;
        let mut emitter_address = vector::empty<u8>();
        vector::append(
            &mut emitter_address,
            x"00000000000000000000000000000000000000000000000000000000deadbeef",
        );

        Gateway::add_trusted_emitter(
            &gateway_admin_cap,
            &mut gateway_state,
            emitter_id,
            emitter_address,
            ctx,
        );

        assert!(Gateway::emitter_exists(&gateway_state, emitter_id));

        // Return objects
        test_scenario::return_to_sender(scenario, gateway_admin_cap);
        test_scenario::return_shared(gateway_state);
    }

    // Function to create a Coin<SUI> for testing purposes
    public fun create_sui_coin(amount: u64, ctx: &mut TxContext): coin::Coin<SUI> {
        let balance = balance::create_for_testing<SUI>(amount);
        coin::from_balance(balance, ctx)
    }

    #[test]
    fun test_initialization() {
        let (admin, coin_deployer) = two_people();
        let mut scenario = test_scenario::begin(admin);

        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_tbtc_for_test_scenario(&mut scenario, admin);
        };

        // Initialize Wormhole
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_wormhole_for_test(&mut scenario, coin_deployer);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            setup::init_test_only(test_scenario::ctx(&mut scenario));
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            Gateway::init_test(test_scenario::ctx(&mut scenario));
        };

        // Initialize Gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            let treasury_cap = test_scenario::take_from_sender<TreasuryCap<TBTC::TBTC>>(&scenario);
            let minter_cap = test_scenario::take_from_sender<TBTC::MinterCap>(&scenario);
            let gateway_admin_cap = test_scenario::take_from_sender<Gateway::AdminCap>(&scenario);
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let wormhole_state = take_wormhole_state(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            // Initialize gateway with wrapped token type
            Gateway::initialize_gateway<coin_wrapped_12::COIN_WRAPPED_12>(
                &gateway_admin_cap,
                &mut gateway_state,
                &wormhole_state,
                minter_cap,
                treasury_cap,
                ctx,
            );

            // Return objects
            test_scenario::return_to_sender(&scenario, gateway_admin_cap);
            test_scenario::return_shared(gateway_state);
            return_wormhole_state(wormhole_state);
        };

        test_scenario::end(scenario);
    }

    #[test]
    fun test_trusted_emitter_management() {
        let (admin, coin_deployer) = two_people();
        let mut scenario = test_scenario::begin(admin);

        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_tbtc_for_test_scenario(&mut scenario, admin);
        };

        // Initialize Wormhole
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_wormhole_for_test(&mut scenario, coin_deployer);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            setup::init_test_only(test_scenario::ctx(&mut scenario));
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            Gateway::init_test(test_scenario::ctx(&mut scenario));
        };

        // Initialize Gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            initialize_gateway_state(&mut scenario);
        };

        test_scenario::end(scenario);
    }

    #[test]
    fun test_removing_emitter() {
        let (admin, coin_deployer) = two_people();
        let mut scenario = test_scenario::begin(admin);

        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_tbtc_for_test_scenario(&mut scenario, admin);
        };

        // Initialize Wormhole
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_wormhole_for_test(&mut scenario, coin_deployer);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            setup::init_test_only(test_scenario::ctx(&mut scenario));
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            Gateway::init_test(test_scenario::ctx(&mut scenario));
        };

        // Initialize Gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            initialize_gateway_state(&mut scenario);
        };

        // Remove emitter
        test_scenario::next_tx(&mut scenario, admin);
        {
            let gateway_admin_cap = test_scenario::take_from_sender<Gateway::AdminCap>(&scenario);
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            let emitter_id = 2;

            Gateway::remove_trusted_emitter(
                &gateway_admin_cap,
                &mut gateway_state,
                emitter_id,
                ctx,
            );

            assert!(!Gateway::emitter_exists(&gateway_state, emitter_id));

            // Return objects
            test_scenario::return_to_sender(&scenario, gateway_admin_cap);
            test_scenario::return_shared(gateway_state);
        };

        test_scenario::end(scenario);
    }

    #[test]
    fun test_pause() {
        let (admin, coin_deployer) = two_people();
        let mut scenario = test_scenario::begin(admin);

        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_tbtc_for_test_scenario(&mut scenario, admin);
        };

        // Initialize Wormhole
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_wormhole_for_test(&mut scenario, coin_deployer);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            setup::init_test_only(test_scenario::ctx(&mut scenario));
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            Gateway::init_test(test_scenario::ctx(&mut scenario));
        };

        // Initialize Gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            initialize_gateway_state(&mut scenario);
        };

        // Pause gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            let gateway_admin_cap = test_scenario::take_from_sender<Gateway::AdminCap>(&scenario);
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            Gateway::pause(&gateway_admin_cap, &mut gateway_state, ctx);

            assert!(Gateway::is_paused(&gateway_state));

            // Return objects
            test_scenario::return_to_sender(&scenario, gateway_admin_cap);
            test_scenario::return_shared(gateway_state);
        };

        test_scenario::end(scenario);
    }

    #[test]
    fun test_unpause() {
        let (admin, coin_deployer) = two_people();
        let mut scenario = test_scenario::begin(admin);

        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_tbtc_for_test_scenario(&mut scenario, admin);
        };

        // Initialize Wormhole
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_wormhole_for_test(&mut scenario, coin_deployer);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            setup::init_test_only(test_scenario::ctx(&mut scenario));
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            Gateway::init_test(test_scenario::ctx(&mut scenario));
        };

        // Initialize Gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            initialize_gateway_state(&mut scenario);
        };

        // Pause gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            let gateway_admin_cap = test_scenario::take_from_sender<Gateway::AdminCap>(&scenario);
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            Gateway::pause(&gateway_admin_cap, &mut gateway_state, ctx);

            assert!(Gateway::is_paused(&gateway_state));

            // Return objects
            test_scenario::return_to_sender(&scenario, gateway_admin_cap);
            test_scenario::return_shared(gateway_state);
        };

        // Unpause gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            let gateway_admin_cap = test_scenario::take_from_sender<Gateway::AdminCap>(&scenario);
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            Gateway::unpause(&gateway_admin_cap, &mut gateway_state, ctx);

            assert!(!Gateway::is_paused(&gateway_state));

            // Return objects
            test_scenario::return_to_sender(&scenario, gateway_admin_cap);
            test_scenario::return_shared(gateway_state);
        };

        test_scenario::end(scenario);
    }

    #[test]
    fun test_send_wrapped_tokens() {
        let (admin, _coin_deployer) = two_people();
        let mut scenario = test_scenario::begin(admin);
        let wormhole_fee = 1;

        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_tbtc_for_test_scenario(&mut scenario, admin);
        };

        // Initialize Wormhole
        test_scenario::next_tx(&mut scenario, admin);
        {
            let expected_source_chain = 2;
            set_up_wormhole_and_token_bridge(&mut scenario, wormhole_fee);
            register_dummy_emitter(&mut scenario, expected_source_chain);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            Gateway::init_test(test_scenario::ctx(&mut scenario));
        };

        // Initialize Gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            initialize_gateway_state(&mut scenario);
        };

        let coin_wrapped = coin_wrapped_12::init_register_and_mint(
            &mut scenario,
            admin,
            1000000000000000,
        );

        // register receiver
        test_scenario::next_tx(&mut scenario, admin);
        {
            let gateway_admin_cap = test_scenario::take_from_sender<Gateway::AdminCap>(&scenario);
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            Gateway::add_trusted_receiver(
                &gateway_admin_cap,
                &mut gateway_state,
                2,
                x"0000000000000000000000000000000000000000000000000000000000000001",
                ctx,
            );

            // Return objects
            test_scenario::return_to_sender(&scenario, gateway_admin_cap);
            test_scenario::return_shared(gateway_state);
        };

        // Send wrapped tokens
        test_scenario::next_tx(&mut scenario, admin);
        {
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let mut capabilities = test_scenario::take_shared<Gateway::GatewayCapabilities>(&scenario);
            let mut token_bridge_state = take_token_bridge_state(&scenario);
            let mut wormhole_state = take_wormhole_state(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            let recipient_chain = 2;
            let mut recipient_address = vector::empty<u8>();
            vector::append(
                &mut recipient_address,
                x"0000000000000000000000000000000000000000000000000000000000000001",
            );

            // get sui native coins
            let sui_coin = create_sui_coin(wormhole_fee, ctx);
            let clock = clock::create_for_testing(ctx);

            Gateway::send_wrapped_tokens<coin_wrapped_12::COIN_WRAPPED_12>(
                &mut gateway_state,
                &mut capabilities,
                &mut token_bridge_state,
                &mut wormhole_state,
                recipient_chain,
                recipient_address,
                coin::from_balance(coin_wrapped, ctx),
                1,
                sui_coin,
                &clock,
                ctx,
            );

            test_scenario::return_shared(gateway_state);
            test_scenario::return_shared(capabilities);
            clock::destroy_for_testing(clock);
            return_wormhole_state(wormhole_state);
            return_token_bridge_state(token_bridge_state);
        };
        test_scenario::end(scenario);
    }

    // Test redeem with dummy message
    #[test]
    fun test_redeem_with_dummy_message() {
        let (admin, _coin_deployer) = two_people();
        let mut scenario = test_scenario::begin(admin);
        let wormhole_fee = 1;

        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_tbtc_for_test_scenario(&mut scenario, admin);
        };

        // Initialize Wormhole
        test_scenario::next_tx(&mut scenario, admin);
        {
            let expected_source_chain = 2;
            set_up_wormhole_and_token_bridge(&mut scenario, wormhole_fee);
            register_dummy_emitter(&mut scenario, expected_source_chain);
            coin_wrapped_12::init_and_register(&mut scenario, admin);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            Gateway::init_test(test_scenario::ctx(&mut scenario));
        };

        // Initialize Gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            initialize_gateway_state(&mut scenario);
        };

        // redeem with dummy message
        test_scenario::next_tx(&mut scenario, admin);
        {
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let mut token_bridge_state = take_token_bridge_state(&scenario);
            let mut wormhole_state = take_wormhole_state(&scenario);
            let mut capabilities = test_scenario::take_shared<Gateway::GatewayCapabilities>(&scenario);
            let mut token_state = test_scenario::take_from_sender<TBTC::TokenState>(&scenario);
            let mut treasury = test_scenario::take_shared<
                Gateway::WrappedTokenTreasury<coin_wrapped_12::COIN_WRAPPED_12>,
            >(&scenario);

            let ctx = test_scenario::ctx(&mut scenario);

            let vaa_bytes = message_with_payload_address();

            let clock = clock::create_for_testing(ctx);

            Gateway::redeem_tokens<coin_wrapped_12::COIN_WRAPPED_12>(
                &mut gateway_state,
                &mut capabilities,
                &mut wormhole_state,
                &mut treasury,
                &mut token_bridge_state,
                &mut token_state,
                vaa_bytes,
                &clock,
                ctx,
            );

            test_scenario::return_shared(gateway_state);
            test_scenario::return_shared(capabilities);
            clock::destroy_for_testing(clock);
            return_wormhole_state(wormhole_state);
            return_token_bridge_state(token_bridge_state);
            test_scenario::return_shared(treasury);
            test_scenario::return_to_sender(&scenario, token_state);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            // get minted amount
            let gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let mut capabilities = test_scenario::take_shared<Gateway::GatewayCapabilities>(&scenario);

            let amount = Gateway::get_minted_amount(&gateway_state);
            assert!(amount == 3000, 100);

            // verify minted amount
            let amount_tbtc = Gateway::get_total_supply(&mut capabilities);
            assert!(amount_tbtc == 3000, 100);

            test_scenario::return_shared(gateway_state);
            test_scenario::return_shared(capabilities);
        };

        test_scenario::end(scenario);
    }

    // Test redeem with dummy message
    #[test]
    fun test_redeem_wrapped_with_dummy_message() {
        let (admin, _coin_deployer) = two_people();
        let mut scenario = test_scenario::begin(admin);
        let wormhole_fee = 1;

        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_tbtc_for_test_scenario(&mut scenario, admin);
        };

        // Initialize Wormhole
        test_scenario::next_tx(&mut scenario, admin);
        {
            let expected_source_chain = 2;
            set_up_wormhole_and_token_bridge(&mut scenario, wormhole_fee);
            register_dummy_emitter(&mut scenario, expected_source_chain);
            coin_wrapped_12::init_and_register(&mut scenario, admin);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            Gateway::init_test(test_scenario::ctx(&mut scenario));
        };

          // Initialize Gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            initialize_gateway_state(&mut scenario);
        };

        // Lower the minting limit
        test_scenario::next_tx(&mut scenario, admin);
        {
            let gateway_admin_cap = test_scenario::take_from_sender<Gateway::AdminCap>(&scenario);
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            Gateway::update_minting_limit(&gateway_admin_cap, &mut gateway_state, 1, ctx);

            // Return objects
            test_scenario::return_to_sender(&scenario, gateway_admin_cap);
            test_scenario::return_shared(gateway_state);
        };


        // redeem with dummy message
        test_scenario::next_tx(&mut scenario, admin);
        {
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let mut token_bridge_state = take_token_bridge_state(&scenario);
            let mut wormhole_state = take_wormhole_state(&scenario);
            let mut capabilities = test_scenario::take_shared<Gateway::GatewayCapabilities>(&scenario);
            let mut token_state = test_scenario::take_from_sender<TBTC::TokenState>(&scenario);
            let mut treasury = test_scenario::take_shared<
                Gateway::WrappedTokenTreasury<coin_wrapped_12::COIN_WRAPPED_12>,
            >(&scenario);

            let ctx = test_scenario::ctx(&mut scenario);

            let vaa_bytes = message_with_payload_address();

            let clock = clock::create_for_testing(ctx);

            Gateway::redeem_tokens<coin_wrapped_12::COIN_WRAPPED_12>(
                &mut gateway_state,
                &mut capabilities,
                &mut wormhole_state,
                &mut treasury,
                &mut token_bridge_state,
                &mut token_state,
                vaa_bytes,
                &clock,
                ctx,
            );

            test_scenario::return_shared(gateway_state);
            test_scenario::return_shared(capabilities);
            clock::destroy_for_testing(clock);
            return_wormhole_state(wormhole_state);
            return_token_bridge_state(token_bridge_state);
            test_scenario::return_shared(treasury);
            test_scenario::return_to_sender(&scenario, token_state);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            let gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let mut capabilities = test_scenario::take_shared<Gateway::GatewayCapabilities>(&scenario);

            // Minted amount should remain 0
            let amount = Gateway::get_minted_amount(&gateway_state);
            assert!(amount == 0, 100);

            // verify no tbtc minted
            let amount_tbtc = Gateway::get_total_supply(&mut capabilities);
            assert!(amount_tbtc == 0, 100);

            test_scenario::return_shared(gateway_state);
            test_scenario::return_shared(capabilities);
        };

        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = Gateway::E_MESSAGE_ALREADY_PROCESSED)]
    fun test_redeem_wrapped_with_dummy_message_already_processed() {
        let (admin, _coin_deployer) = two_people();
        let mut scenario = test_scenario::begin(admin);
        let wormhole_fee = 1;

        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_tbtc_for_test_scenario(&mut scenario, admin);
        };

        // Initialize Wormhole
        test_scenario::next_tx(&mut scenario, admin);
        {
            let expected_source_chain = 2;
            set_up_wormhole_and_token_bridge(&mut scenario, wormhole_fee);
            register_dummy_emitter(&mut scenario, expected_source_chain);
            coin_wrapped_12::init_and_register(&mut scenario, admin);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            Gateway::init_test(test_scenario::ctx(&mut scenario));
        };

        // Initialize Gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            initialize_gateway_state(&mut scenario);
        };

        // Lower the minting limit
        test_scenario::next_tx(&mut scenario, admin);
        {
            let gateway_admin_cap = test_scenario::take_from_sender<Gateway::AdminCap>(&scenario);
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            Gateway::update_minting_limit(&gateway_admin_cap, &mut gateway_state, 1, ctx);

            // Return objects
            test_scenario::return_to_sender(&scenario, gateway_admin_cap);
            test_scenario::return_shared(gateway_state);
        };

        // redeem with dummy message
        test_scenario::next_tx(&mut scenario, admin);
        {
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let mut token_bridge_state = take_token_bridge_state(&scenario);
            let mut wormhole_state = take_wormhole_state(&scenario);
            let mut capabilities = test_scenario::take_shared<Gateway::GatewayCapabilities>(&scenario);
            let mut token_state = test_scenario::take_from_sender<TBTC::TokenState>(&scenario);
            let mut treasury = test_scenario::take_shared<
                Gateway::WrappedTokenTreasury<coin_wrapped_12::COIN_WRAPPED_12>,
            >(&scenario);

            let ctx = test_scenario::ctx(&mut scenario);

            let vaa_bytes = message_with_payload_address();

            let clock = clock::create_for_testing(ctx);

            Gateway::redeem_tokens<coin_wrapped_12::COIN_WRAPPED_12>(
                &mut gateway_state,
                &mut capabilities,
                &mut wormhole_state,
                &mut treasury,
                &mut token_bridge_state,
                &mut token_state,
                vaa_bytes,
                &clock,
                ctx,
            );

            test_scenario::return_shared(gateway_state);
            test_scenario::return_shared(capabilities);
            clock::destroy_for_testing(clock);
            return_wormhole_state(wormhole_state);
            return_token_bridge_state(token_bridge_state);
            test_scenario::return_shared(treasury);
            test_scenario::return_to_sender(&scenario, token_state);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            let gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let mut capabilities = test_scenario::take_shared<Gateway::GatewayCapabilities>(&scenario);

            // Minted amount should remain 0
            let amount = Gateway::get_minted_amount(&gateway_state);
            assert!(amount == 0, 100);

            // verify no tbtc minted
            let amount_tbtc = Gateway::get_total_supply(&mut capabilities);
            assert!(amount_tbtc == 0, 100);

            test_scenario::return_shared(gateway_state);
            test_scenario::return_shared(capabilities);
        };

        // redeem with dummy message
        test_scenario::next_tx(&mut scenario, admin);
        {
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let mut token_bridge_state = take_token_bridge_state(&scenario);
            let mut wormhole_state = take_wormhole_state(&scenario);
            let mut capabilities = test_scenario::take_shared<Gateway::GatewayCapabilities>(&scenario);
            let mut token_state = test_scenario::take_from_sender<TBTC::TokenState>(&scenario);
            let mut treasury = test_scenario::take_shared<
                Gateway::WrappedTokenTreasury<coin_wrapped_12::COIN_WRAPPED_12>,
            >(&scenario);

            let ctx = test_scenario::ctx(&mut scenario);

            let vaa_bytes = message_with_payload_address();

            let clock = clock::create_for_testing(ctx);

            Gateway::redeem_tokens<coin_wrapped_12::COIN_WRAPPED_12>(
                &mut gateway_state,
                &mut capabilities,
                &mut wormhole_state,
                &mut treasury,
                &mut token_bridge_state,
                &mut token_state,
                vaa_bytes,
                &clock,
                ctx,
            );

            test_scenario::return_shared(gateway_state);
            test_scenario::return_shared(capabilities);
            clock::destroy_for_testing(clock);
            return_wormhole_state(wormhole_state);
            return_token_bridge_state(token_bridge_state);
            test_scenario::return_shared(treasury);
            test_scenario::return_to_sender(&scenario, token_state);
        };

        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = Gateway::E_INVALID_CHAIN_ID)]
    fun test_invalid_chain() {
        let (admin, _coin_deployer) = two_people();
        let mut scenario = test_scenario::begin(admin);
        let wormhole_fee = 1;

        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_tbtc_for_test_scenario(&mut scenario, admin);
        };

        // Initialize Wormhole
        test_scenario::next_tx(&mut scenario, admin);
        {
            let expected_source_chain = 2;
            set_up_wormhole_and_token_bridge(&mut scenario, wormhole_fee);
            register_dummy_emitter(&mut scenario, expected_source_chain);
            coin_wrapped_12::init_and_register(&mut scenario, admin);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            Gateway::init_test(test_scenario::ctx(&mut scenario));
        };

        // Initialize Gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            let treasury_cap = test_scenario::take_from_sender<TreasuryCap<TBTC::TBTC>>(&scenario);
            let minter_cap = test_scenario::take_from_sender<TBTC::MinterCap>(&scenario);
            let gateway_admin_cap = test_scenario::take_from_sender<Gateway::AdminCap>(&scenario);
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let emitter_cap: EmitterCap = emitter::dummy();

            // Initialize gateway with wrapped token type
            Gateway::initialize_gateway_test<coin_wrapped_12::COIN_WRAPPED_12>(
                &mut gateway_state,
                minter_cap,
                treasury_cap,
                ctx,
                emitter_cap,
            );

            // Verify initialization by trying to add a trusted emitter
            let emitter_id = 4;
            let mut emitter_address = vector::empty<u8>();
            vector::append(
                &mut emitter_address,
                x"00000000000000000000000000000000000000000000000000000000deadbeef",
            );

            Gateway::add_trusted_emitter(
                &gateway_admin_cap,
                &mut gateway_state,
                emitter_id,
                emitter_address,
                ctx,
            );

            assert!(Gateway::emitter_exists(&gateway_state, emitter_id));

            // Return objects
            test_scenario::return_to_sender(&scenario, gateway_admin_cap);
            test_scenario::return_shared(gateway_state);
        };

        // Lower the minting limit
        test_scenario::next_tx(&mut scenario, admin);
        {
            let gateway_admin_cap = test_scenario::take_from_sender<Gateway::AdminCap>(&scenario);
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            Gateway::update_minting_limit(&gateway_admin_cap, &mut gateway_state, 1, ctx);

            // Return objects
            test_scenario::return_to_sender(&scenario, gateway_admin_cap);
            test_scenario::return_shared(gateway_state);
        };

        // redeem with dummy message
        test_scenario::next_tx(&mut scenario, admin);
        {
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let mut token_bridge_state = take_token_bridge_state(&scenario);
            let mut wormhole_state = take_wormhole_state(&scenario);
            let mut capabilities = test_scenario::take_shared<Gateway::GatewayCapabilities>(&scenario);
            let mut token_state = test_scenario::take_from_sender<TBTC::TokenState>(&scenario);
            let mut treasury = test_scenario::take_shared<
                Gateway::WrappedTokenTreasury<coin_wrapped_12::COIN_WRAPPED_12>,
            >(&scenario);

            let ctx = test_scenario::ctx(&mut scenario);

            let vaa_bytes = message_with_payload_address();

            let clock = clock::create_for_testing(ctx);

            Gateway::redeem_tokens<coin_wrapped_12::COIN_WRAPPED_12>(
                &mut gateway_state,
                &mut capabilities,
                &mut wormhole_state,
                &mut treasury,
                &mut token_bridge_state,
                &mut token_state,
                vaa_bytes,
                &clock,
                ctx,
            );

            test_scenario::return_shared(gateway_state);
            test_scenario::return_shared(capabilities);
            clock::destroy_for_testing(clock);
            return_wormhole_state(wormhole_state);
            return_token_bridge_state(token_bridge_state);
            test_scenario::return_shared(treasury);
            test_scenario::return_to_sender(&scenario, token_state);
        };

        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = Gateway::E_INVALID_SENDER)]
    fun test_invalid_sender() {
        let (admin, _coin_deployer) = two_people();
        let mut scenario = test_scenario::begin(admin);
        let wormhole_fee = 1;

        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_tbtc_for_test_scenario(&mut scenario, admin);
        };

        // Initialize Wormhole
        test_scenario::next_tx(&mut scenario, admin);
        {
            let expected_source_chain = 2;
            set_up_wormhole_and_token_bridge(&mut scenario, wormhole_fee);
            register_dummy_emitter(&mut scenario, expected_source_chain);
            coin_wrapped_12::init_and_register(&mut scenario, admin);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            Gateway::init_test(test_scenario::ctx(&mut scenario));
        };

        // Initialize Gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            let treasury_cap = test_scenario::take_from_sender<TreasuryCap<TBTC::TBTC>>(&scenario);
            let minter_cap = test_scenario::take_from_sender<TBTC::MinterCap>(&scenario);
            let gateway_admin_cap = test_scenario::take_from_sender<Gateway::AdminCap>(&scenario);
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let emitter_cap: EmitterCap = emitter::dummy();

            // Initialize gateway with wrapped token type
            Gateway::initialize_gateway_test<coin_wrapped_12::COIN_WRAPPED_12>(
                &mut gateway_state,
                minter_cap,
                treasury_cap,
                ctx,
                emitter_cap,
            );

            // Verify initialization by trying to add a trusted emitter
            let emitter_id = 2;
            let mut emitter_address = vector::empty<u8>();
            vector::append(
                &mut emitter_address,
                x"00000000000000000000000000000000000000000000000000000000deadbeee",
            );

            Gateway::add_trusted_emitter(
                &gateway_admin_cap,
                &mut gateway_state,
                emitter_id,
                emitter_address,
                ctx,
            );

            assert!(Gateway::emitter_exists(&gateway_state, emitter_id));

            // Return objects
            test_scenario::return_to_sender(&scenario, gateway_admin_cap);
            test_scenario::return_shared(gateway_state);
        };

        // Lower the minting limit
        test_scenario::next_tx(&mut scenario, admin);
        {
            let gateway_admin_cap = test_scenario::take_from_sender<Gateway::AdminCap>(&scenario);
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            Gateway::update_minting_limit(&gateway_admin_cap, &mut gateway_state, 1, ctx);

            // Return objects
            test_scenario::return_to_sender(&scenario, gateway_admin_cap);
            test_scenario::return_shared(gateway_state);
        };

        // redeem with dummy message
        test_scenario::next_tx(&mut scenario, admin);
        {
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let mut token_bridge_state = take_token_bridge_state(&scenario);
            let mut wormhole_state = take_wormhole_state(&scenario);
            let mut capabilities = test_scenario::take_shared<Gateway::GatewayCapabilities>(&scenario);
            let mut token_state = test_scenario::take_from_sender<TBTC::TokenState>(&scenario);
            let mut treasury = test_scenario::take_shared<
                Gateway::WrappedTokenTreasury<coin_wrapped_12::COIN_WRAPPED_12>,
            >(&scenario);

            let ctx = test_scenario::ctx(&mut scenario);

            let vaa_bytes = message_with_payload_address();

            let clock = clock::create_for_testing(ctx);

            Gateway::redeem_tokens<coin_wrapped_12::COIN_WRAPPED_12>(
                &mut gateway_state,
                &mut capabilities,
                &mut wormhole_state,
                &mut treasury,
                &mut token_bridge_state,
                &mut token_state,
                vaa_bytes,
                &clock,
                ctx,
            );

            test_scenario::return_shared(gateway_state);
            test_scenario::return_shared(capabilities);
            clock::destroy_for_testing(clock);
            return_wormhole_state(wormhole_state);
            return_token_bridge_state(token_bridge_state);
            test_scenario::return_shared(treasury);
            test_scenario::return_to_sender(&scenario, token_state);
        };

        test_scenario::end(scenario);
    }

     #[test]
     #[expected_failure(abort_code = Gateway::E_PAUSED)]
    fun test_paused_error() {
        let (admin, coin_deployer) = two_people();
        let mut scenario = test_scenario::begin(admin);

        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_tbtc_for_test_scenario(&mut scenario, admin);
        };

        // Initialize Wormhole
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_wormhole_for_test(&mut scenario, coin_deployer);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            setup::init_test_only(test_scenario::ctx(&mut scenario));
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            Gateway::init_test(test_scenario::ctx(&mut scenario));
        };

        // Initialize Gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            initialize_gateway_state(&mut scenario);
        };

        // Pause gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            let gateway_admin_cap = test_scenario::take_from_sender<Gateway::AdminCap>(&scenario);
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            Gateway::pause(&gateway_admin_cap, &mut gateway_state, ctx);

            assert!(Gateway::is_paused(&gateway_state));

            // Return objects
            test_scenario::return_to_sender(&scenario, gateway_admin_cap);
            test_scenario::return_shared(gateway_state);
        };

           // redeem with dummy message
        test_scenario::next_tx(&mut scenario, admin);
        {
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let mut token_bridge_state = take_token_bridge_state(&scenario);
            let mut wormhole_state = take_wormhole_state(&scenario);
            let mut capabilities = test_scenario::take_shared<Gateway::GatewayCapabilities>(&scenario);
            let mut token_state = test_scenario::take_from_sender<TBTC::TokenState>(&scenario);
            let mut treasury = test_scenario::take_shared<
                Gateway::WrappedTokenTreasury<coin_wrapped_12::COIN_WRAPPED_12>,
            >(&scenario);

            let ctx = test_scenario::ctx(&mut scenario);

            let vaa_bytes = message_with_payload_address();

            let clock = clock::create_for_testing(ctx);

            Gateway::redeem_tokens<coin_wrapped_12::COIN_WRAPPED_12>(
                &mut gateway_state,
                &mut capabilities,
                &mut wormhole_state,
                &mut treasury,
                &mut token_bridge_state,
                &mut token_state,
                vaa_bytes,
                &clock,
                ctx,
            );

            test_scenario::return_shared(gateway_state);
            test_scenario::return_shared(capabilities);
            clock::destroy_for_testing(clock);
            return_wormhole_state(wormhole_state);
            return_token_bridge_state(token_bridge_state);
            test_scenario::return_shared(treasury);
            test_scenario::return_to_sender(&scenario, token_state);
        };


        test_scenario::end(scenario);
    }

    #[test]
    fun test_constants() {
        let (admin, coin_deployer) = two_people();
        let mut scenario = test_scenario::begin(admin);

        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_tbtc_for_test_scenario(&mut scenario, admin);
        };

        // Initialize Wormhole
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_wormhole_for_test(&mut scenario, coin_deployer);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            setup::init_test_only(test_scenario::ctx(&mut scenario));
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            Gateway::init_test(test_scenario::ctx(&mut scenario));
        };

        

        // Test initialization state
        test_scenario::next_tx(&mut scenario, admin);
        {
            let gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            assert!(!Gateway::is_initialized(&gateway_state), 0);
            assert!(!Gateway::is_paused(&gateway_state), 0);
            assert!(Gateway::get_minting_limit(&gateway_state) == 1000000000000000000, 0);
            assert!(Gateway::get_minted_amount(&gateway_state) == 0, 0);
            test_scenario::return_shared(gateway_state);
        };

        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = Gateway::E_NOT_INITIALIZED)]
    fun test_not_initialized_error() {
        let (admin, coin_deployer) = two_people();
        let mut scenario = test_scenario::begin(admin);

        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_tbtc_for_test_scenario(&mut scenario, admin);
        };

        // Initialize Wormhole
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_wormhole_for_test(&mut scenario, coin_deployer);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            setup::init_test_only(test_scenario::ctx(&mut scenario));
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            Gateway::init_test(test_scenario::ctx(&mut scenario));
        };

        // Try to add trusted emitter before initialization
        test_scenario::next_tx(&mut scenario, admin);
        {
            let gateway_admin_cap = test_scenario::take_from_sender<Gateway::AdminCap>(&scenario);
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            let emitter_id = 2;
            let mut emitter_address = vector::empty<u8>();
            vector::append(
                &mut emitter_address,
                x"00000000000000000000000000000000000000000000000000000000deadbeef",
            );

            Gateway::add_trusted_emitter(
                &gateway_admin_cap,
                &mut gateway_state,
                emitter_id,
                emitter_address,
                ctx,
            );

            test_scenario::return_to_sender(&scenario, gateway_admin_cap);
            test_scenario::return_shared(gateway_state);
        };

        test_scenario::end(scenario);
    }


    #[test]
    fun test_minting_limit_management() {
        let (admin, coin_deployer) = two_people();
        let mut scenario = test_scenario::begin(admin);

        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_tbtc_for_test_scenario(&mut scenario, admin);
        };

        // Initialize Wormhole
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_wormhole_for_test(&mut scenario, coin_deployer);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            setup::init_test_only(test_scenario::ctx(&mut scenario));
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            Gateway::init_test(test_scenario::ctx(&mut scenario));
        };

        // Initialize Gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            initialize_gateway_state(&mut scenario);
        };

        // Update minting limit
        test_scenario::next_tx(&mut scenario, admin);
        {
            let gateway_admin_cap = test_scenario::take_from_sender<Gateway::AdminCap>(&scenario);
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            let new_limit = 1000;
            Gateway::update_minting_limit(&gateway_admin_cap, &mut gateway_state, new_limit, ctx);

            assert!(Gateway::get_minting_limit(&gateway_state) == new_limit, 0);

            test_scenario::return_to_sender(&scenario, gateway_admin_cap);
            test_scenario::return_shared(gateway_state);
        };

        test_scenario::end(scenario);
    }

    #[test]
    fun test_treasury_operations() {
        let (admin, coin_deployer) = two_people();
        let mut scenario = test_scenario::begin(admin);

        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_tbtc_for_test_scenario(&mut scenario, admin);
        };

        // Initialize Wormhole
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_wormhole_for_test(&mut scenario, coin_deployer);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            setup::init_test_only(test_scenario::ctx(&mut scenario));
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            Gateway::init_test(test_scenario::ctx(&mut scenario));
        };

        // Initialize Gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            initialize_gateway_state(&mut scenario);
        };

        // Test treasury operations through redeem with dummy message
        test_scenario::next_tx(&mut scenario, admin);
        {
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let mut token_bridge_state = take_token_bridge_state(&scenario);
            let mut wormhole_state = take_wormhole_state(&scenario);
            let mut capabilities = test_scenario::take_shared<Gateway::GatewayCapabilities>(&scenario);
            let mut token_state = test_scenario::take_from_sender<TBTC::TokenState>(&scenario);
            let mut treasury = test_scenario::take_shared<
                Gateway::WrappedTokenTreasury<coin_wrapped_12::COIN_WRAPPED_12>,
            >(&scenario);

            let ctx = test_scenario::ctx(&mut scenario);

            let vaa_bytes = message_with_payload_address();

            let clock = clock::create_for_testing(ctx);

            Gateway::redeem_tokens<coin_wrapped_12::COIN_WRAPPED_12>(
                &mut gateway_state,
                &mut capabilities,
                &mut wormhole_state,
                &mut treasury,
                &mut token_bridge_state,
                &mut token_state,
                vaa_bytes,
                &clock,
                ctx,
            );

            test_scenario::return_shared(gateway_state);
            test_scenario::return_shared(capabilities);
            clock::destroy_for_testing(clock);
            return_wormhole_state(wormhole_state);
            return_token_bridge_state(token_bridge_state);
            test_scenario::return_shared(treasury);
            test_scenario::return_to_sender(&scenario, token_state);
        };

        test_scenario::end(scenario);
    }

    #[test]
    fun test_admin_capabilities() {
        let (admin, coin_deployer) = two_people();
        let mut scenario = test_scenario::begin(admin);

        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_tbtc_for_test_scenario(&mut scenario, admin);
        };

        // Initialize Wormhole
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_wormhole_for_test(&mut scenario, coin_deployer);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            setup::init_test_only(test_scenario::ctx(&mut scenario));
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            Gateway::init_test(test_scenario::ctx(&mut scenario));
        };

        // Initialize Gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            initialize_gateway_state(&mut scenario);
        };

        // Test admin capabilities
        test_scenario::next_tx(&mut scenario, admin);
        {
            let gateway_admin_cap = test_scenario::take_from_sender<Gateway::AdminCap>(&scenario);
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            // Test pause
            Gateway::pause(&gateway_admin_cap, &mut gateway_state, ctx);
            assert!(Gateway::is_paused(&gateway_state), 0);

            // Test unpause
            Gateway::unpause(&gateway_admin_cap, &mut gateway_state, ctx);
            assert!(!Gateway::is_paused(&gateway_state), 0);

            // Test update minting limit
            let new_limit = 1000;
            Gateway::update_minting_limit(&gateway_admin_cap, &mut gateway_state, new_limit, ctx);
            assert!(Gateway::get_minting_limit(&gateway_state) == new_limit, 0);

            test_scenario::return_to_sender(&scenario, gateway_admin_cap);
            test_scenario::return_shared(gateway_state);
        };

        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = Gateway::E_WRONG_NONCE)]
    fun test_wrong_nonce() {
       let (admin, _coin_deployer) = two_people();
        let mut scenario = test_scenario::begin(admin);
        let wormhole_fee = 1;

        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_tbtc_for_test_scenario(&mut scenario, admin);
        };

        // Initialize Wormhole
        test_scenario::next_tx(&mut scenario, admin);
        {
            let expected_source_chain = 2;
            set_up_wormhole_and_token_bridge(&mut scenario, wormhole_fee);
            register_dummy_emitter(&mut scenario, expected_source_chain);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            Gateway::init_test(test_scenario::ctx(&mut scenario));
        };

        // Initialize Gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            initialize_gateway_state(&mut scenario);
        };

        let coin_wrapped = coin_wrapped_12::init_register_and_mint(
            &mut scenario,
            admin,
            1000000000000000,
        );

        // register receiver
        test_scenario::next_tx(&mut scenario, admin);
        {
            let gateway_admin_cap = test_scenario::take_from_sender<Gateway::AdminCap>(&scenario);
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            Gateway::add_trusted_receiver(
                &gateway_admin_cap,
                &mut gateway_state,
                2,
                x"0000000000000000000000000000000000000000000000000000000000000001",
                ctx,
            );

            // Return objects
            test_scenario::return_to_sender(&scenario, gateway_admin_cap);
            test_scenario::return_shared(gateway_state);
        };

        // Send wrapped tokens
        test_scenario::next_tx(&mut scenario, admin);
        {
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let mut capabilities = test_scenario::take_shared<Gateway::GatewayCapabilities>(&scenario);
            let mut token_bridge_state = take_token_bridge_state(&scenario);
            let mut wormhole_state = take_wormhole_state(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            let recipient_chain = 2;
            let mut recipient_address = vector::empty<u8>();
            vector::append(
                &mut recipient_address,
                x"0000000000000000000000000000000000000000000000000000000000000001",
            );

            // get sui native coins
            let sui_coin = create_sui_coin(wormhole_fee, ctx);
            let clock = clock::create_for_testing(ctx);

            Gateway::send_wrapped_tokens<coin_wrapped_12::COIN_WRAPPED_12>(
                &mut gateway_state,
                &mut capabilities,
                &mut token_bridge_state,
                &mut wormhole_state,
                recipient_chain,
                recipient_address,
                coin::from_balance(coin_wrapped, ctx),
                2,
                sui_coin,
                &clock,
                ctx,
            );

            test_scenario::return_shared(gateway_state);
            test_scenario::return_shared(capabilities);
            clock::destroy_for_testing(clock);
            return_wormhole_state(wormhole_state);
            return_token_bridge_state(token_bridge_state);
        };
        test_scenario::end(scenario);
    }

     #[test]
    fun test_nonce_reset() {
       let (admin, _coin_deployer) = two_people();
        let mut scenario = test_scenario::begin(admin);
        let wormhole_fee = 1;

        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, admin);
        {
            init_tbtc_for_test_scenario(&mut scenario, admin);
        };

        // Initialize Wormhole
        test_scenario::next_tx(&mut scenario, admin);
        {
            let expected_source_chain = 2;
            set_up_wormhole_and_token_bridge(&mut scenario, wormhole_fee);
            register_dummy_emitter(&mut scenario, expected_source_chain);
        };

        test_scenario::next_tx(&mut scenario, admin);
        {
            Gateway::init_test(test_scenario::ctx(&mut scenario));
        };

        // Initialize Gateway
        test_scenario::next_tx(&mut scenario, admin);
        {
            initialize_gateway_state(&mut scenario);
        };

        let coin_wrapped = coin_wrapped_12::init_register_and_mint(
            &mut scenario,
            admin,
            1000000000000000,
        );

        // register receiver
        test_scenario::next_tx(&mut scenario, admin);
        {
            let gateway_admin_cap = test_scenario::take_from_sender<Gateway::AdminCap>(&scenario);
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            Gateway::add_trusted_receiver(
                &gateway_admin_cap,
                &mut gateway_state,
                2,
                x"0000000000000000000000000000000000000000000000000000000000000001",
                ctx,
            );

            // Return objects
            test_scenario::return_to_sender(&scenario, gateway_admin_cap);
            test_scenario::return_shared(gateway_state);
        };

        // Set nonce to max
        test_scenario::next_tx(&mut scenario, admin);
        {
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);

            Gateway::set_nonce(&mut gateway_state, 4_294_967_293u32);

            test_scenario::return_shared(gateway_state);
        };

        // Send wrapped tokens
        test_scenario::next_tx(&mut scenario, admin);
        {
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let mut capabilities = test_scenario::take_shared<Gateway::GatewayCapabilities>(&scenario);
            let mut token_bridge_state = take_token_bridge_state(&scenario);
            let mut wormhole_state = take_wormhole_state(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            let recipient_chain = 2;
            let mut recipient_address = vector::empty<u8>();
            vector::append(
                &mut recipient_address,
                x"0000000000000000000000000000000000000000000000000000000000000001",
            );

            // get sui native coins
            let sui_coin = create_sui_coin(wormhole_fee, ctx);
            let clock = clock::create_for_testing(ctx);

            Gateway::send_wrapped_tokens<coin_wrapped_12::COIN_WRAPPED_12>(
                &mut gateway_state,
                &mut capabilities,
                &mut token_bridge_state,
                &mut wormhole_state,
                recipient_chain,
                recipient_address,
                coin::from_balance(coin_wrapped, ctx),
                4_294_967_294u32,
                sui_coin,
                &clock,
                ctx,
            );

            test_scenario::return_shared(gateway_state);
            test_scenario::return_shared(capabilities);
            clock::destroy_for_testing(clock);
            return_wormhole_state(wormhole_state);
            return_token_bridge_state(token_bridge_state);
        };

        // check if nonce is reset
        test_scenario::next_tx(&mut scenario, admin);
        {
            let gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);

            assert!(Gateway::check_nonce(&gateway_state) == 0, 0);

            test_scenario::return_shared(gateway_state);
        };
        test_scenario::end(scenario);
    }
}