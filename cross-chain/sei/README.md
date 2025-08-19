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

## Deployment System

### Overview

The project features a comprehensive deployment and verification system using `hardhat-deploy` with secure encrypted key management. All scripts support both **Sei Testnet** and **Base Sepolia** networks.

### 📁 File Structure

```
cross-chain/sei/
├── deploy/                              # Hardhat-deploy scripts
│   ├── 01_deploy_sei_testnet_token.ts   # Sei testnet deployment
│   ├── 02_deploy_base_sepolia_token.ts  # Base Sepolia deployment  
│   ├── 03_verify_sei_testnet_token.ts   # Sei testnet verification
│   └── 04_verify_base_sepolia_token.ts  # Base Sepolia verification
├── scripts/                             # Core deployment utilities
│   ├── deploy-l2tbtc-encrypted.ts       # Generic deployment function
│   ├── verify-deployment.ts             # Generic verification function
│   ├── secure-key-manager.ts            # Encrypted key management
│   ├── encrypt-account.ts               # Account encryption utility
│   └── use-account.ts                   # Account usage utility
└── .env                                 # Environment configuration
```

### 🔐 Security Features

- **Encrypted Private Keys**: All private keys stored in `.encrypted-key` files
- **Console Password Input**: Master password entered securely via console
- **Multi-Account Support**: Support for multiple encrypted accounts (`.encrypted-key-N`)
- **Environment Variables**: API keys and dynamic parameters via `.env`

### 🚀 Deployment Commands

#### **Sei Testnet Deployment**
```bash
# Deploy L2TBTC token
npx hardhat deploy --network sei_atlantic_2 --tags SeiTestnetToken

# Verify deployment (with specific proxy address)
PROXY_ADDRESS=0x... npx hardhat run scripts/verify-deployment.ts --network sei_atlantic_2

# Deploy + Verify in sequence
npx hardhat deploy --network sei_atlantic_2 --tags SeiTestnetToken,VerifySeiTestnetToken
```

#### **Base Sepolia Deployment**
```bash
# Deploy L2TBTC token
npx hardhat deploy --network baseSepolia --tags BaseSepoliaToken

# Verify deployment (proxy address required)
PROXY_ADDRESS=0x... npx hardhat run scripts/verify-deployment.ts --network baseSepolia

# Deploy + Verify in sequence  
PROXY_ADDRESS=0x... npx hardhat deploy --network baseSepolia --tags BaseSepoliaToken,VerifyBaseSepoliaToken
```

### 🔧 Setup Process

#### **1. Install Dependencies**
```bash
npm install
```

#### **2. Setup Environment**
```bash
# Get your API key from https://etherscan.io/apis (free registration required)
# Create .env file with your API key
echo "ETHERSCAN_API_KEY=your_etherscan_api_key_here" > .env

# Or copy from example and edit
cp .env.example .env
# Then edit .env with your actual API key
```

#### **3. Encrypt Private Key**
```bash
# For account #1 (deployer)
npx hardhat run scripts/encrypt-account.ts
# Prompts for private key and master password

# For additional accounts
ACCOUNT_NUMBER=2 npx hardhat run scripts/encrypt-account.ts
```

#### **4. Deploy and Verify**

**Sei Testnet:**
```bash
# Full deployment process
npx hardhat deploy --network sei_atlantic_2 --tags SeiTestnetToken

# Get deployed proxy address and verify
PROXY_ADDRESS=0x... npx hardhat run scripts/verify-deployment.ts --network sei_atlantic_2
```

**Base Sepolia:**
```bash
# Full deployment process
npx hardhat deploy --network baseSepolia --tags BaseSepoliaToken

# Get deployed proxy address and verify
PROXY_ADDRESS=0x... npx hardhat run scripts/verify-deployment.ts --network baseSepolia
```

### 📋 Verification Features

The verification system automatically:
- ✅ **Contract Validation**: Checks owner, name, symbol, decimals, total supply
- ✅ **Minter Setup**: Adds deployer as minter if not already set
- ✅ **Token Testing**: Mints 100 test tokens to verify functionality
- ✅ **Explorer Links**: Provides direct links to block explorers
- ✅ **Network Detection**: Auto-detects Sei Testnet vs Base Sepolia
- ✅ **Balance Checks**: Monitors deployer ETH balance
- ✅ **Error Handling**: Comprehensive error reporting and debugging info

### 🏷️ Available Tags

| Tag | Purpose | Dependencies |
|-----|---------|--------------|
| `SeiTestnetToken` | Deploy on Sei Testnet | None |
| `BaseSepoliaToken` | Deploy on Base Sepolia | None |
| `VerifySeiTestnetToken` | Verify Sei deployment | `SeiTestnetToken` |
| `VerifyBaseSepoliaToken` | Verify Base Sepolia deployment | `BaseSepoliaToken` |
| `L2TBTC` | Generic L2TBTC deployment | Used by network-specific tags |
| `Verify` | Generic verification | Used by verification tags |

### 🌐 Network Support

#### **Sei Testnet (sei_atlantic_2)**
- **RPC**: `https://evm-rpc-testnet.sei-apis.com`
- **Explorer**: `https://seitrace.com`
- **Chain ID**: `713715`
- **Token**: `Sei tBTC v2` (`tBTC`)

#### **Base Sepolia (baseSepolia)**
- **RPC**: `https://sepolia.base.org`
- **Explorer**: `https://sepolia.basescan.org`
- **Chain ID**: `84532`
- **Token**: `Base tBTC v2` (`tBTC`)

### 🔍 Verification Commands

#### **Generic Verification Script**
```bash
# Verify any deployed contract
PROXY_ADDRESS=0x... npx hardhat run scripts/verify-deployment.ts --network <network>
```

#### **Using Hardhat-Deploy Tags**
```bash
# Sei Testnet verification only
npx hardhat deploy --network sei_atlantic_2 --tags VerifySeiTestnetToken

# Base Sepolia verification only (requires PROXY_ADDRESS)
PROXY_ADDRESS=0x... npx hardhat deploy --network baseSepolia --tags VerifyBaseSepoliaToken
```

### 📊 Example Output

```bash
🔍 Verifying L2TBTC deployment...
📋 Using proxy address: 0xe3dE7061A112Fb05A1a84a709e03988ae8703e15
🔐 Loading deployer from encrypted key...
✅ Using deployer: 0xB6A114C2c34eF91eeb0d93bcdDD7B95a9D6892E1

📋 Contract Information:
   Proxy Address: 0xe3dE7061A112Fb05A1a84a709e03988ae8703e15
   Network: Sei Testnet
   Explorer: https://seitrace.com/address/0xe3dE7061A112Fb05A1a84a709e03988ae8703e15
💰 Deployer balance: 4.94 ETH

🔍 Reading contract state...
   Contract Owner: 0xB6A114C2c34eF91eeb0d93bcdDD7B95a9D6892E1
   Token Name: Sei tBTC v2
   Token Symbol: tBTC
   Decimals: 18
   Total Supply: 100.0 tBTC
   Is Deployer Minter: true
   All Minters: 0xB6A114C2c34eF91eeb0d93bcdDD7B95a9D6892E1
   ✅ Ownership correctly set to deployer
   ✅ Deployer is already a minter

🎉 Contract verification completed successfully!
🔗 View on explorer: https://seitrace.com/address/0xe3dE7061A112Fb05A1a84a709e03988ae8703e15
```

### 🛠️ Advanced Usage

#### **Multiple Account Management**
```bash
# Encrypt additional accounts
ACCOUNT_NUMBER=2 npx hardhat run scripts/encrypt-account.ts
ACCOUNT_NUMBER=3 npx hardhat run scripts/encrypt-account.ts

# Use specific account for operations
ACCOUNT_NUMBER=2 npx hardhat run scripts/use-account.ts
```

#### **Environment Variables**
```bash
# .env file configuration
ETHERSCAN_API_KEY=your_etherscan_api_key_here
PROXY_ADDRESS=0x...  # For verification scripts
ACCOUNT_NUMBER=1     # For account-specific operations
```

#### **Custom Verification**
```bash
# Verify specific proxy address
PROXY_ADDRESS=0x123... npx hardhat run scripts/verify-deployment.ts --network sei_atlantic_2

# Override default fallback address
PROXY_ADDRESS=0x456... npx hardhat run scripts/verify-deployment.ts --network baseSepolia
```

### ⚡ Quick Commands Summary

| Action | Sei Testnet | Base Sepolia |
|--------|-------------|--------------|
| **Deploy** | `npx hardhat deploy --network sei_atlantic_2 --tags SeiTestnetToken` | `npx hardhat deploy --network baseSepolia --tags BaseSepoliaToken` |
| **Verify** | `PROXY_ADDRESS=0x... npx hardhat run scripts/verify-deployment.ts --network sei_atlantic_2` | `PROXY_ADDRESS=0x... npx hardhat run scripts/verify-deployment.ts --network baseSepolia` |
| **Both** | `npx hardhat deploy --network sei_atlantic_2 --tags SeiTestnetToken,VerifySeiTestnetToken` | `PROXY_ADDRESS=0x... npx hardhat deploy --network baseSepolia --tags BaseSepoliaToken,VerifyBaseSepoliaToken` |

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

### Sei Testnet (Atlantic-2)
- **L2TBTC Proxy**: `0xe3dE7061A112Fb05A1a84a709e03988ae8703e15` *(Latest)*
- **Implementation**: `0x2252087dAaCA6B0Ec03ac25039030810435752E7`
- **Admin**: `0x98aF01b95f1DE886461213bfB74F91fc782b1948`
- **Owner**: `0xB6A114C2c34eF91eeb0d93bcdDD7B95a9D6892E1`

### Base Sepolia (Testnet)
- **L2TBTC Proxy**: `TBD` *(Deploy using: `npx hardhat deploy --network baseSepolia --tags BaseSepoliaToken`)*
- **Implementation**: `TBD`
- **Admin**: `TBD`
- **Owner**: `TBD`

### Mainnet (when deployed)
- **Sei Mainnet**: `TBD`
- **Base Mainnet**: `TBD`

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

### 🔐 Key Management Scripts
```bash
# Encrypt private keys
npx hardhat run scripts/encrypt-account.ts                    # Account #1 (default)
ACCOUNT_NUMBER=2 npx hardhat run scripts/encrypt-account.ts   # Account #2
ACCOUNT_NUMBER=N npx hardhat run scripts/encrypt-account.ts   # Account #N

# Use encrypted accounts
npx hardhat run scripts/use-account.ts                        # Account #1 (default)
ACCOUNT_NUMBER=2 npx hardhat run scripts/use-account.ts       # Account #2
```

### 🚀 Deployment Scripts
```bash
# Sei Testnet
npx hardhat deploy --network sei_atlantic_2 --tags SeiTestnetToken

# Base Sepolia  
npx hardhat deploy --network baseSepolia --tags BaseSepoliaToken
```

### 🔍 Verification Scripts
```bash
# Generic verification (both networks)
PROXY_ADDRESS=0x... npx hardhat run scripts/verify-deployment.ts --network <network>

# Network-specific verification via tags
npx hardhat deploy --network sei_atlantic_2 --tags VerifySeiTestnetToken
PROXY_ADDRESS=0x... npx hardhat deploy --network baseSepolia --tags VerifyBaseSepoliaToken
```

### 🛠️ Development Scripts
```bash
# Standard development
npm run build             # Compile contracts
npm run test              # Run tests
npm run clean             # Clean build artifacts

# Direct script execution (legacy)
npx hardhat run scripts/deploy-l2tbtc-encrypted.ts --network <network>
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