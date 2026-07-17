# tBTC Sui Move Contracts

This repository contains Sui Move contracts for integrating tBTC functionality, including:

- **tBTC Coin Module**: Defines the tBTC coin type and related operations.
- **Wormhole Gateway Module**: Facilitates cross-chain interactions using the Wormhole protocol.
- **Bitcoin Depositor Module**: Manages Bitcoin deposit processes within the Sui network.

## Documentation

For detailed documentation and usage instructions of the specific contract check their respective documentation files.

- [Bitcoin Depositor Contract](/docs/bitcoin_depositor.md)
- [Gateway Contract](/docs/gateway.md)
- [tBTC Coin Contract](/docs/tbtc.md)

### Audit

Audit report is available [here](/docs/audit_report.pdf).

## Prerequisites

Before deploying these contracts, ensure you have the following installed:

- **Sui CLI**: Command-line interface for interacting with the Sui network. [Installation Guide](https://docs.sui.io/guides/getting-started)
- **Move Analyzer**: Tool for analyzing and testing Move modules. [Move Analyzer Tutorial](https://blog.sui.io/move-analyzer-tutorial/)

## Project Structure

```
tbtc-sui-move/
├── docs/
│   ├── bitcoin_depositor.md
│   ├── tbtc.md
│   ├── gateway.md
├── sources/
│   ├── token
│   ├── ├── tbtc.move
│   ├── gateway
│   |   ├── helpers.move
│   |   ├── wormhole_gateway.move
│   ├── bitcoin_depositor
│   |   ├── bitcoin_depositor.move
│   ├── ...
├── tests/
│   ├── l2_tbtc_tests.move
│   ├── other tests...
├── Move.toml
└── README.md
```

- **docs/**: Contains project documentation in Markdown format.
- **sources/**: Contains the Move modules for tBTC coin, Wormhole gateway, and Bitcoin depositor.
- **tests/**: Includes test scripts for the respective modules.
- **Move.toml**: Package manifest file detailing dependencies and addresses.

## Building and testing Steps

1. **Clone the Repository and get Wormhole stuff**:

   ```bash
   git clone https://github.com/4-point-0/tbtc-sui-integration.git
   ```

2. **Clone the Wormhole Repository**:

   Clone the Wormhole repository from GitHub in the same directory as tbtc-sui-move:

   ```bash
   git clone https://github.com/wormhole-foundation/wormhole.git
   cd tbtc-sui-move
   ```

3. **Copy two files from wormhole repo to the shared directory**:

   ```
   ./wormhole/sui/wormhole

   ./wormhole/sui/token_bridge
   ```

4. **Attach published-at**
 
   In both of these we need to locate move.toml and change/add the published_at field to their respective addresses where they are deployed.

   example for testnet for both of them: 

   ```bash
   #token_bridge
   published-at = "0x562760fc51d90d4ae1835bac3e91e0e6987d3497b06f066941d3e51f6e8d76d0"

   #wormhole
   published-at = "0xf47329f4344f3bf0f8e436e2f7b485466cff300f12a166563995d3888c296a94"
   ```

5. **Build the Modules**:

   Compile the Move modules to ensure there are no errors:

   ```bash
   cd tbtc-sui-integration
   sui move build -d
   ```

6. **Run Tests**:

   Execute the test scripts to validate module functionality:

   ```bash
   sui move test
   ```

7. **Publish Modules**:

   Deploy the modules to the Sui network:

   ```bash
   sui client publish ./ --gas-budget 1000000
   ```

## Usage

After deployment, you can interact with the modules using the Sui CLI or integrate them into your applications. Refer to the module documentation for available entry functions and their parameters.

## Resources

- [Sui Documentation](https://docs.sui.io/)
- [Move Language Overview](https://move-language.github.io/move/)
- [Wormhole Protocol Documentation](https://wormhole.com/docs/)