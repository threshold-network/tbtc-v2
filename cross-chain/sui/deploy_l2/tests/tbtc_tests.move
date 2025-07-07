#[test_only]
module l2_tbtc::l2_tbtc_tests {

use l2_tbtc::TBTC;
use sui::coin::{TreasuryCap, Coin};
use sui::test_scenario;
use token_bridge::token_bridge_scenario::{two_people, person};

// Helper function to initialize TBTC for testing
fun init_tbtc_for_test_scenario(scenario: &mut test_scenario::Scenario, admin: address) {
    let (admin_cap, mut token_state, treasury_cap) = TBTC::initialize_for_test(
        test_scenario::ctx(scenario)
    );
    TBTC::add_minter(&admin_cap, &mut token_state, admin, test_scenario::ctx(scenario));
    transfer::public_transfer(token_state, admin);
    transfer::public_transfer(treasury_cap, admin);
    transfer::public_transfer(admin_cap, admin);
}

#[test]
fun test_initialization() {
    let (admin, _) = two_people();
    let mut scenario = test_scenario::begin(admin);

    // Initialize TBTC
    test_scenario::next_tx(&mut scenario, admin);
    {
        init_tbtc_for_test_scenario(&mut scenario, admin);
    };

    test_scenario::end(scenario);
}

#[test]
fun test_add_remove_minter() {
    let (admin, new_minter) = two_people();
    let mut scenario = test_scenario::begin(admin);

    // Initialize TBTC
    test_scenario::next_tx(&mut scenario, admin);
    {
        init_tbtc_for_test_scenario(&mut scenario, admin);
    };

    // Add minter
    test_scenario::next_tx(&mut scenario, admin);
    {
        let admin_cap = test_scenario::take_from_sender<TBTC::AdminCap>(&scenario);
        let mut token_state = test_scenario::take_from_sender<TBTC::TokenState>(&scenario);
        let ctx = test_scenario::ctx(&mut scenario);

        TBTC::add_minter(
            &admin_cap,
            &mut token_state,
            new_minter,
            ctx,
        );
        assert!(TBTC::is_minter(&token_state, new_minter), 0);

        test_scenario::return_to_sender(&scenario, admin_cap);
        test_scenario::return_to_sender(&scenario, token_state);
    };

    // Remove minter
    test_scenario::next_tx(&mut scenario, admin);
    {
        let admin_cap = test_scenario::take_from_sender<TBTC::AdminCap>(&scenario);
        let mut token_state = test_scenario::take_from_sender<TBTC::TokenState>(&scenario);
        let ctx = test_scenario::ctx(&mut scenario);

        TBTC::remove_minter(
            &admin_cap,
            &mut token_state,
            new_minter,
            ctx,
        );
        assert!(!TBTC::is_minter(&token_state, new_minter), 0);

        test_scenario::return_to_sender(&scenario, admin_cap);
        test_scenario::return_to_sender(&scenario, token_state);
    };

    test_scenario::end(scenario);
}

#[test]
fun test_mint() {
    let (admin, new_minter) = two_people();
    let mut scenario = test_scenario::begin(admin);

    // Initialize TBTC
    test_scenario::next_tx(&mut scenario, admin);
    {
        init_tbtc_for_test_scenario(&mut scenario, admin);
    };

    // Mint tokens
    test_scenario::next_tx(&mut scenario, admin);
    {
        let minter_cap = test_scenario::take_from_sender<TBTC::MinterCap>(&scenario);
        let token_state = test_scenario::take_from_sender<TBTC::TokenState>(&scenario);
        let mut treasury_cap = test_scenario::take_from_sender<TreasuryCap<TBTC::TBTC>>(&scenario);
        let ctx = test_scenario::ctx(&mut scenario);

        let mint_amount = 1000;
        TBTC::mint(
            &minter_cap,
            &mut treasury_cap,
            &token_state,
            mint_amount,
            new_minter,
            ctx,
        );

        test_scenario::return_to_sender(&scenario, minter_cap);
        test_scenario::return_to_sender(&scenario, token_state);
        test_scenario::return_to_sender(&scenario, treasury_cap);
    };

    test_scenario::end(scenario);
}


#[test]
#[expected_failure(abort_code = TBTC::E_ALREADY_MINTER)]
fun test_already_minter() {
    let (admin, new_minter) = two_people();
    let mut scenario = test_scenario::begin(admin);

    // Initialize TBTC
    test_scenario::next_tx(&mut scenario, admin);
    {
        init_tbtc_for_test_scenario(&mut scenario, admin);
    };

    // Add minter
    test_scenario::next_tx(&mut scenario, admin);
    {
        let admin_cap = test_scenario::take_from_sender<TBTC::AdminCap>(&scenario);
        let mut token_state = test_scenario::take_from_sender<TBTC::TokenState>(&scenario);
        let ctx = test_scenario::ctx(&mut scenario);

        TBTC::add_minter(
            &admin_cap,
            &mut token_state,
            admin,
            ctx,
        );
        assert!(TBTC::is_minter(&token_state, new_minter), 0);

        test_scenario::return_to_sender(&scenario, admin_cap);
        test_scenario::return_to_sender(&scenario, token_state);
    };

    test_scenario::end(scenario);
}

#[test]
#[expected_failure(abort_code = test_scenario::EEmptyInventory)]
fun test_non_minter_cannot_mint() {
    let (admin, non_minter) = two_people();
    let mut scenario = test_scenario::begin(admin);

    // Initialize TBTC
    test_scenario::next_tx(&mut scenario, admin);
    {
        init_tbtc_for_test_scenario(&mut scenario, admin);
    };

    // Try to mint without being a minter
    test_scenario::next_tx(&mut scenario, non_minter);
    {
        let minter_cap = test_scenario::take_from_sender<TBTC::MinterCap>(&scenario);
        // Cannot mint without being a minter, which means having a minter capability
        // This will abort with EEmptyInventory
        test_scenario::return_to_sender(&scenario, minter_cap);
    };

    test_scenario::end(scenario);
}

#[test]
fun test_burn() {
    let admin = person();
    let mut scenario = test_scenario::begin(admin);

    // Initialize TBTC
    test_scenario::next_tx(&mut scenario, admin);
    {
        init_tbtc_for_test_scenario(&mut scenario, admin);
    };

    // Mint tokens
    test_scenario::next_tx(&mut scenario, admin);
    {
        let minter_cap = test_scenario::take_from_sender<TBTC::MinterCap>(&scenario);
        let token_state = test_scenario::take_from_sender<TBTC::TokenState>(&scenario);
        let mut treasury_cap = test_scenario::take_from_sender<TreasuryCap<TBTC::TBTC>>(&scenario);
        let ctx = test_scenario::ctx(&mut scenario);

        let mint_amount = 1000;
        TBTC::mint(
            &minter_cap,
            &mut treasury_cap,
            &token_state,
            mint_amount,
            admin,
            ctx,
        );

        test_scenario::return_to_sender(&scenario, minter_cap);
        test_scenario::return_to_sender(&scenario, token_state);
        test_scenario::return_to_sender(&scenario, treasury_cap);
    };

    // Burn tokens
    test_scenario::next_tx(&mut scenario, admin);
    {
        let mut treasury_cap = test_scenario::take_from_sender<TreasuryCap<TBTC::TBTC>>(&scenario);
        let token_state = test_scenario::take_from_sender<TBTC::TokenState>(&scenario);
        let coins = test_scenario::take_from_sender<Coin<TBTC::TBTC>>(&scenario);

        TBTC::burn(
            &mut treasury_cap,
            &token_state,
            coins,

        );

        test_scenario::return_to_sender(&scenario, treasury_cap);
        test_scenario::return_to_sender(&scenario, token_state);
    };

    test_scenario::end(scenario);
}

}