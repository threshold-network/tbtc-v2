#[test_only]
module l2_tbtc::mint_authorization_tests {
    use l2_tbtc::TBTC;
    use sui::test_scenario;
    use sui::transfer;

    const ADMIN: address = @0xAD;
    const MINTER: address = @0x1234;

    /// A MinterCap issued to an address that is later removed from the minters
    /// list must not be able to mint: `mint` checks that the cap's minter is
    /// still an active minter, so `remove_minter` revokes the retained cap.
    #[test]
    #[expected_failure(abort_code = TBTC::E_NOT_MINTER)]
    fun test_removed_minter_cannot_mint_with_retained_cap() {
        let mut scenario = test_scenario::begin(ADMIN);

        test_scenario::next_tx(&mut scenario, ADMIN);
        {
            let (admin_cap, mut token_state, mut treasury_cap) =
                TBTC::initialize_for_test(test_scenario::ctx(&mut scenario));

            // Add the minter and retain its MinterCap object.
            let minter_cap = TBTC::add_minter_with_cap(
                &admin_cap,
                &mut token_state,
                MINTER,
                test_scenario::ctx(&mut scenario),
            );
            assert!(TBTC::is_minter(&token_state, MINTER), 0);

            // Remove the minter from the active list. The cap object still
            // exists in hand because it cannot be destroyed on removal.
            TBTC::remove_minter(
                &admin_cap,
                &mut token_state,
                MINTER,
                test_scenario::ctx(&mut scenario),
            );
            assert!(!TBTC::is_minter(&token_state, MINTER), 1);

            // Minting with the retained cap must now abort with E_NOT_MINTER.
            TBTC::mint(
                &minter_cap,
                &mut treasury_cap,
                &token_state,
                1000,
                MINTER,
                test_scenario::ctx(&mut scenario),
            );

            // Unreachable after the expected abort, but required so the
            // non-droppable objects are consumed on the type-checked path.
            transfer::public_transfer(minter_cap, ADMIN);
            transfer::public_transfer(token_state, ADMIN);
            transfer::public_transfer(treasury_cap, ADMIN);
            transfer::public_transfer(admin_cap, ADMIN);
        };

        test_scenario::end(scenario);
    }
}
