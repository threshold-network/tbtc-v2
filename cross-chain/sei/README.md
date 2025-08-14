# tBTC Sei Network Integration - Canonical L2TBTC

## Overview

This directory contains the canonical L2TBTC implementation for Sei Network, enabling native Bitcoin-backed tokens with secure cross-chain functionality. The implementation follows the standard tBTC v2 canonical pattern with upgradeable contracts and comprehensive access controls.

### Why This Approach is Better

#### **Canonical Purity**
- **Zero modifications** to proven L2TBTC contract
- **No custom interfaces** or bridge-specific functions
- **Standard ownership** and minter management
- **Battle-tested** canonical behavior preserved

#### **Bitcoin-Backed Native Tokens**
- **Direct Bitcoin backing** via L1 vault (not hub-and-spoke)
- **Native Sei tokens** backed by real Bitcoin custody
- **No liquidity pools** or wrapped token complexity
- **True multichain Bitcoin** with enhanced security

#### **Manual Deployment Advantages**
- **Full control** over deployment process
- **Custom rate limits** for Bitcoin-specific use cases
- **Tailored security** parameters for high-value assets
- **No dependency** on standard CLI tools designed for generic tokens

## Architecture

```
L2TBTC.sol (Sei)
├── Inherits: OpenZeppelin upgradeable contracts
├── Provides: Canonical tBTC functionality
├── Features: addMinter/removeMinter interface
└── Maintains: Full canonical tBTC security model
```

## Key Features

### 🔒 **Canonical tBTC Implementation**
- Full L2TBTC canonical functionality (minting, burning, pausing, guardians)
- Upgradeable contract architecture with TransparentUpgradeableProxy
- Comprehensive access controls and security features
- EIP2612 permit support for gasless approvals

### 🌉 **Cross-Chain Bridge Ready**
- `addMinter(address)` function for bridge authorization
- `removeMinter(address)` function for security management
- Guardian system for emergency controls
- Pausable functionality for risk management

### **Enhanced Security**
- Multi-minter support for bridge ecosystems
- Guardian pause mechanisms for emergency situations
- Owner-controlled minter and guardian management
- Upgradeable architecture for future enhancements

## Contract Details

### Core Functions

```solidity
// Minter management
function addMinter(address minter) external onlyOwner
function removeMinter(address minter) external onlyOwner
function getMinters() external view returns (address[] memory)

// Guardian management
function addGuardian(address guardian) external onlyOwner
function removeGuardian(address guardian) external onlyOwner
function getGuardians() external view returns (address[] memory)

// Token operations
function mint(address account, uint256 amount) external whenNotPaused onlyMinter
function burn(uint256 amount) public override whenNotPaused
function burnFrom(address account, uint256 amount) public override whenNotPaused

// Emergency controls
function pause() external onlyGuardian
function unpause() external onlyOwner

// Recovery functions
function recoverERC20(IERC20Upgradeable token, address recipient, uint256 amount) external onlyOwner
function recoverERC721(IERC721Upgradeable token, address recipient, uint256 tokenId, bytes calldata data) external onlyOwner
```

### Canonical Features

- **Full canonical L2TBTC implementation** with complete compliance
- `addMinter/removeMinter` interface for bridge authorization
- Guardian system for emergency controls
- Pausable functionality for risk management
- EIP2612 permit support for gasless operations
- Upgradeable architecture with TransparentUpgradeableProxy
- ERC20Burnable with burnFrom functionality
- Owner-controlled access management

## Deployment Process

### 1. Setup Encrypted Private Key

```bash
# Setup secure key management
npm run setup-key
```

### 2. Deploy L2TBTC on Sei Testnet

```bash
# Deploy with encrypted private key
npm run deploy:encrypted
```

### 3. Verify Contracts

```bash
# Verify proxy contract
npm run verify:sei <PROXY_ADDRESS>

# Verify implementation contract
npm run verify:sei <IMPLEMENTATION_ADDRESS>
```

### 4. Configure Bridge Minters

```bash
# Add bridge as minter (example)
cast send $PROXY_ADDRESS \
  "addMinter(address)" $BRIDGE_ADDRESS \
  --rpc-url https://evm-rpc-testnet.sei-apis.com \
  --private-key $PRIVATE_KEY
```

## Integration with Cross-Chain Bridges

### Flow Diagram

```
Bitcoin Deposit → Ethereum L1 → Bridge → Sei Network
     ↓              ↓              ↓              ↓
Real Bitcoin → L1 tBTC Mint → Bridge Message → Native Sei tBTC
```

### Bridge Integration Points

1. **Bridge Contract**: Must be added as minter via `addMinter()`
2. **Minting Authority**: Only authorized minters can mint tokens
3. **Emergency Controls**: Guardians can pause during incidents
4. **Upgrade Path**: Owner can upgrade implementation if needed

### Bitcoin-Backed Flow

```
Bitcoin Deposit → Ethereum L1 → Bridge → Sei Network
     ↓              ↓              ↓              ↓
Real Bitcoin → L1 tBTC Mint → Bridge Message → Native Sei tBTC
   (Vault)       (Canonical)    (Enhanced)     (Pure L2TBTC)
```

## Security Considerations

### Access Controls
- **Owner**: Can add/remove minters and guardians, upgrade contracts
- **Guardians**: Can pause contract during emergencies
- **Minters**: Only authorized bridges can mint new tokens

### Emergency Procedures
```solidity
// Guardian can pause all operations
contract.pause()

// Owner can remove compromised minter
contract.removeMinter(compromisedMinter)

// Owner can upgrade implementation
upgradeTo(newImplementation)
```

### Upgrade Safety
- TransparentUpgradeableProxy ensures upgrade safety
- Implementation can be upgraded while preserving state
- Admin controls upgrade process

## Testing

### Unit Tests
```bash
# Test canonical functionality
npm run test

# Test specific contract features
npx hardhat test --grep "L2TBTC"
```

### Integration Tests
```bash
# Test deployment and verification
npm run deploy:encrypted
npm run verify:sei <ADDRESS>
```

### Bitcoin-Specific Testing
```bash
# Test canonical functionality
npm test -- --grep "L2TBTC"

# Test bridge integration
npm test -- --grep "Bridge Integration"

# Test Bitcoin-specific scenarios
npm test -- --grep "Bitcoin Flow"
```

## Contract Addresses

### Testnet (Atlantic-2)
- **L2TBTC Proxy**: `0x967152D6677baaadBdeFcA6b99307B51e30CeB03`
- **Implementation**: `0x78E48eBCACabdee321e30D62a3144b8552Ce923F`
- **Admin**: `0xB6A114C2c34eF91eeb0d93bcdDD7B95a9D6892E1`

### Mainnet (when deployed)
- **L2TBTC Proxy**: `TBD`
- **Implementation**: `TBD`
- **Admin**: `TBD`

## Monitoring and Maintenance

### Key Metrics
- Minter activity and authorization status
- Guardian actions and pause events
- Token mint/burn volumes
- Upgrade events and implementation changes

### Alerts
- Unauthorized minting attempts
- Emergency pause events
- Minter addition/removal events
- Contract upgrade events

## Upgrade Path

The contract follows the canonical tBTC upgrade process:
1. Governance proposal through established channels
2. Guardian approval for emergency upgrades
3. Time-locked implementation for normal upgrades
4. TransparentUpgradeableProxy ensures upgrade safety

## Available Scripts

```bash
# Key management
npm run setup-key          # Setup encrypted private key
npm run test-key           # Test key decryption
npm run remove-key         # Remove encrypted key

# Deployment
npm run deploy:encrypted   # Deploy with encrypted key

# Verification
npm run verify:sei <ADDRESS>  # Verify contract on SeiTrace

# Development
npm run build             # Compile contracts
npm run test              # Run tests
npm run clean             # Clean build artifacts
```

## Benefits Over Complex Interface Approach

| Aspect | Canonical Approach | Interface Approach |
|--------|-------------------|-------------------|
| **Complexity** | Simple | Complex |
| **Security** | Proven canonical code | Custom modifications |
| **Maintenance** | Standard upgrades | Custom upgrade paths |
| **Tooling** | Works with all L2TBTC tools | May break tooling |
| **Deployment** | Manual control | CLI dependency |
| **Bitcoin Focus** | Optimized for Bitcoin | Generic token approach |

## Why This is Perfect for tBTC

1. **Bitcoin-Backed**: Real Bitcoin custody, not wrapped tokens
2. **Native Experience**: Full DeFi composability on Sei
3. **Enhanced Security**: Bridge + Bitcoin vault backing
4. **Canonical Purity**: Zero risk from custom modifications
5. **Manual Control**: Bitcoin-appropriate deployment and configuration

This approach gives you **true Bitcoin-backed native tokens** with **enterprise-grade security** while maintaining **100% canonical compatibility**.

## Support

For technical support and integration questions:
- Technical Documentation: [tBTC v2 Documentation](https://docs.threshold.network/)
- Integration Support: Contact Threshold Network team
- Bug Reports: Create issue in tBTC-v2 repository
- Contract Explorer: [SeiTrace](https://seitrace.com/atlantic-2)