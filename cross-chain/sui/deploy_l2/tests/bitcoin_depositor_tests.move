#[test_only]
module l2_tbtc::bitcoin_depositor_tests {

    use l2_tbtc::BitcoinDepositor;
    use l2_tbtc::Gateway;
    use l2_tbtc::TBTC;
    use l2_tbtc::test_utils::message_with_payload_address;
    use sui::clock;
    use sui::coin::TreasuryCap;
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

    // Helper function to initialize Gateway for testing
    public fun initialize_gateway_state(scenario: &mut test_scenario::Scenario) {
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

    // Helper function to initialize TBTC for testing
    fun init_tbtc_for_test_scenario(scenario: &mut test_scenario::Scenario, admin: address) {
        let (admin_cap, mut token_state, treasury_cap) = TBTC::initialize_for_test(
            test_scenario::ctx(scenario),
        );
        TBTC::add_minter(&admin_cap, &mut token_state, admin, test_scenario::ctx(scenario));
        transfer::public_transfer(token_state, admin);
        transfer::public_transfer(treasury_cap, admin);
        transfer::public_transfer(admin_cap, admin);
    }

    // Helper function to initialize Wormhole for testing
    fun init_wormhole_for_test(scenario: &mut test_scenario::Scenario, deployer: address) {
        let expected_source_chain = 2;
        set_up_wormhole_and_token_bridge(scenario, 1);
        register_dummy_emitter(scenario, expected_source_chain);
        coin_wrapped_12::init_and_register(scenario, deployer);
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

        // Initialize BitcoinDepositor
        test_scenario::next_tx(&mut scenario, admin);
        {
            BitcoinDepositor::init_test(test_scenario::ctx(&mut scenario));
        };

        test_scenario::end(scenario);
    }

    #[test]
    fun test_set_trusted_emitter() {
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

        // Initialize BitcoinDepositor
        test_scenario::next_tx(&mut scenario, admin);
        {
            BitcoinDepositor::init_test(test_scenario::ctx(&mut scenario));
        };

        // Set trusted emitter
        test_scenario::next_tx(&mut scenario, admin);
        {
            let admin_cap = test_scenario::take_from_sender<BitcoinDepositor::AdminCap>(&scenario);
            let mut receiver_state = test_scenario::take_shared<BitcoinDepositor::ReceiverState>(
                &scenario,
            );
            let ctx = test_scenario::ctx(&mut scenario);

            let mut emitter_address = vector::empty<u8>();
            vector::append(
                &mut emitter_address,
                x"0000000000000000000000000000000000000000000000000000000000000001",
            );

            BitcoinDepositor::set_trusted_emitter(
                &admin_cap,
                &mut receiver_state,
                emitter_address,
                ctx,
            );

            // Return objects
            test_scenario::return_to_sender(&scenario, admin_cap);
            test_scenario::return_shared(receiver_state);
        };

        test_scenario::end(scenario);
    }

    #[test]
    fun test_initialize_deposit() {
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

        // Initialize BitcoinDepositor
        test_scenario::next_tx(&mut scenario, admin);
        {
            BitcoinDepositor::init_test(test_scenario::ctx(&mut scenario));
        };

        // Initialize deposit
        test_scenario::next_tx(&mut scenario, admin);
        {
            let ctx = test_scenario::ctx(&mut scenario);

            let mut funding_tx = vector::empty<u8>();
            vector::append(&mut funding_tx, x"deadbeef");

            let mut deposit_reveal = vector::empty<u8>();
            vector::append(&mut deposit_reveal, x"cafebabe");

            let mut deposit_owner = vector::empty<u8>();
            vector::append(&mut deposit_owner, x"12345678");

            BitcoinDepositor::initialize_deposit(
                funding_tx,
                deposit_reveal,
                deposit_owner,
                ctx,
            );
        };

        test_scenario::end(scenario);
    }

    #[test]
    fun test_receive_wormhole_messages() {
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

        // Initialize BitcoinDepositor
        test_scenario::next_tx(&mut scenario, admin);
        {
            BitcoinDepositor::init_test(test_scenario::ctx(&mut scenario));
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

        // Set trusted emitter
        test_scenario::next_tx(&mut scenario, admin);
        {
            let admin_cap = test_scenario::take_from_sender<BitcoinDepositor::AdminCap>(&scenario);
            let mut receiver_state = test_scenario::take_shared<BitcoinDepositor::ReceiverState>(
                &scenario,
            );
            let ctx = test_scenario::ctx(&mut scenario);

            let mut emitter_address = vector::empty<u8>();
            vector::append(
                &mut emitter_address,
                x"00000000000000000000000000000000000000000000000000000000deadbeef",
            );

            BitcoinDepositor::set_trusted_emitter(
                &admin_cap,
                &mut receiver_state,
                emitter_address,
                ctx,
            );

            // Return objects
            test_scenario::return_to_sender(&scenario, admin_cap);
            test_scenario::return_shared(receiver_state);
        };

        // Process Wormhole message
        test_scenario::next_tx(&mut scenario, admin);
        {
            let mut receiver_state = test_scenario::take_shared<BitcoinDepositor::ReceiverState>(
                &scenario,
            );
            let mut gateway_state = test_scenario::take_shared<Gateway::GatewayState>(&scenario);
            let mut capabilities = test_scenario::take_shared<Gateway::GatewayCapabilities>(&scenario);
            let mut treasury = test_scenario::take_shared<
                Gateway::WrappedTokenTreasury<coin_wrapped_12::COIN_WRAPPED_12>,
            >(&scenario);
            let mut wormhole_state = take_wormhole_state(&scenario);
            let mut token_bridge_state = take_token_bridge_state(&scenario);
            let mut token_state = test_scenario::take_from_sender<TBTC::TokenState>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            let vaa_bytes = message_with_payload_address();

            let clock = clock::create_for_testing(ctx);

            BitcoinDepositor::receiveWormholeMessages<coin_wrapped_12::COIN_WRAPPED_12>(
                &mut receiver_state,
                &mut gateway_state,
                &mut capabilities,
                &mut treasury,
                &mut wormhole_state,
                &mut token_bridge_state,
                &mut token_state,
                vaa_bytes,
                &clock,
                ctx,
            );

            // Return objects
            test_scenario::return_shared(receiver_state);
            test_scenario::return_shared(gateway_state);
            test_scenario::return_shared(capabilities);
            test_scenario::return_shared(treasury);
            return_wormhole_state(wormhole_state);
            return_token_bridge_state(token_bridge_state);
            test_scenario::return_to_sender(&scenario, token_state);
            clock::destroy_for_testing(clock);
        };

        test_scenario::end(scenario);
    }
}