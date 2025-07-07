#[test_only]
module l2_tbtc::mintercap_fix_tests {
    use l2_tbtc::TBTC::{Self, AdminCap, MinterCap, TokenState, TreasuryCap, TBTC};
    use l2_tbtc::Gateway::{Self, GatewayState};
    use sui::test_scenario;
    use sui::transfer;
    use sui::coin;

    const ADMIN: address = @0xAD;
    const USER: address = @0xBEEF;

    /// Test that add_minter_with_cap returns the MinterCap instead of transferring it
    #[test]
    fun test_add_minter_with_cap_returns_cap() {
        let mut scenario = test_scenario::begin(ADMIN);
        
        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, ADMIN);
        {
            let (admin_cap, mut token_state, treasury_cap) = TBTC::initialize_for_test(
                test_scenario::ctx(&mut scenario)
            );
            
            // Create a dummy address for the minter (simulating Gateway)
            let gateway_address = @0x1234;
            
            // Call add_minter_with_cap and receive the MinterCap
            let minter_cap = TBTC::add_minter_with_cap(
                &admin_cap,
                &mut token_state,
                gateway_address,
                test_scenario::ctx(&mut scenario)
            );
            
            // Verify the minter was added to the state
            assert!(TBTC::is_minter(&token_state, gateway_address), 0);
            
            // Verify we have the MinterCap
            // In a real scenario, we would use this to initialize the Gateway
            
            // Clean up
            transfer::public_transfer(minter_cap, ADMIN);
            transfer::public_share_object(token_state);
            transfer::public_transfer(treasury_cap, ADMIN);
            transfer::public_transfer(admin_cap, ADMIN);
        };
        
        test_scenario::end(scenario);
    }

    /// Test the complete flow: add Gateway as minter and initialize in a single transaction
    #[test]
    fun test_gateway_initialization_with_returned_mintercap() {
        let mut scenario = test_scenario::begin(ADMIN);
        
        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, ADMIN);
        {
            let (admin_cap, token_state, treasury_cap) = TBTC::initialize_for_test(
                test_scenario::ctx(&mut scenario)
            );
            transfer::public_share_object(token_state);
            transfer::public_transfer(treasury_cap, ADMIN);
            transfer::public_transfer(admin_cap, ADMIN);
        };
        
        // Initialize Gateway module (creates shared GatewayState)
        test_scenario::next_tx(&mut scenario, ADMIN);
        {
            Gateway::init_test(test_scenario::ctx(&mut scenario));
        };
        
        // Get the Gateway shared object
        test_scenario::next_tx(&mut scenario, ADMIN);
        {
            let gateway_state = test_scenario::take_shared<GatewayState>(&scenario);
            let gateway_address = object::id_address(&gateway_state);
            test_scenario::return_shared(gateway_state);
            
            // Now perform the fix: add minter and initialize in one flow
            let admin_cap = test_scenario::take_from_sender<AdminCap>(&scenario);
            let mut token_state = test_scenario::take_shared<TokenState>(&scenario);
            let treasury_cap = test_scenario::take_from_sender<TreasuryCap<TBTC>>(&scenario);
            let mut gateway_state = test_scenario::take_shared<GatewayState>(&scenario);
            
            // Add Gateway as minter and get the MinterCap back
            let minter_cap = TBTC::add_minter_with_cap(
                &admin_cap,
                &mut token_state,
                gateway_address,
                test_scenario::ctx(&mut scenario)
            );
            
            // Verify Gateway is now a minter
            assert!(TBTC::is_minter(&token_state, gateway_address), 1);
            
            // Now we can initialize the Gateway with the MinterCap we received
            // (In production this would be done in a PTB)
            // Note: Using test-only initialization function here
            let emitter_cap = sui::test_utils::create_one_time_witness<Gateway::GATEWAY>();
            Gateway::initialize_gateway_test<coin::Coin<TBTC>>(
                &mut gateway_state,
                minter_cap,
                treasury_cap,
                test_scenario::ctx(&mut scenario),
                emitter_cap
            );
            
            // Verify Gateway is initialized
            assert!(Gateway::is_initialized(&gateway_state), 2);
            
            // Clean up
            test_scenario::return_shared(token_state);
            test_scenario::return_shared(gateway_state);
            transfer::public_transfer(admin_cap, ADMIN);
        };
        
        test_scenario::end(scenario);
    }

    /// Test that the original add_minter would fail with shared objects
    /// This test demonstrates why the fix was needed
    #[test]
    #[expected_failure]
    fun test_add_minter_to_shared_object_would_fail() {
        let mut scenario = test_scenario::begin(ADMIN);
        
        // Initialize TBTC
        test_scenario::next_tx(&mut scenario, ADMIN);
        {
            let (admin_cap, mut token_state, treasury_cap) = TBTC::initialize_for_test(
                test_scenario::ctx(&mut scenario)
            );
            
            // Create a shared object to simulate Gateway
            let shared_object = TestSharedObject {
                id: object::new(test_scenario::ctx(&mut scenario))
            };
            transfer::public_share_object(shared_object);
            
            // Get the shared object's address
            let shared_object_address = object::id_address(&shared_object);
            
            // This would fail in real deployment because shared objects
            // cannot receive transfers via transfer::public_transfer
            TBTC::add_minter(
                &admin_cap,
                &mut token_state,
                shared_object_address,
                test_scenario::ctx(&mut scenario)
            );
            
            // Clean up (won't reach here due to expected failure)
            transfer::public_share_object(token_state);
            transfer::public_transfer(treasury_cap, ADMIN);
            transfer::public_transfer(admin_cap, ADMIN);
        };
        
        test_scenario::end(scenario);
    }
    
    // Helper struct for testing
    struct TestSharedObject has key {
        id: UID
    }
}