// SPDX-License-Identifier: GPL-3.0-only

module l2_tbtc::helpers{

    use wormhole::bytes32;
    use wormhole::external_address::{Self, ExternalAddress};

    const E_INVALID_PAYLOAD: u64 = 9;

    public(package) fun parse_encoded_address(payload: &vector<u8>): address {
        // Verify we have enough data in the payload
        assert!(vector::length(payload) >= 32, E_INVALID_PAYLOAD);

        // Create a byte array to hold our address
        let mut addr_bytes = vector::empty<u8>();

        // Copy the first 32 bytes from the payload - these are our address bytes
        let mut i = 0;
        while (i < 32) {
            vector::push_back(&mut addr_bytes, *vector::borrow(payload, i));
            i = i + 1;
        };

        // Convert the bytes to a Sui address
        // In Sui, addresses are 32 bytes (same as Wormhole external addresses)
        let ext_address = external_address::new(bytes32::new(addr_bytes));
        external_address::to_address(ext_address)
    }

    public(package) fun encode_address(addr: ExternalAddress): vector<u8> {
        // Convert the address to its raw bytes
        let addr_bytes = external_address::to_bytes(addr);

        // Return the bytes
        addr_bytes
    }
}