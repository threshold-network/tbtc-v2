# tBTC Direct Minting on Sei Network

# Wormhole NTT Enhanced Implementation

Version 2.0 - Direct Bitcoin-Backed Architecture

## Glossary

**Direct Minting**: Architecture where Bitcoin deposits on L1 trigger native tBTC minting on L2, backed by real Bitcoin in L1 vault. Superior to hub-and-spoke as it creates truly native tokens.

**NTT (Native Token Transfers)**: Wormhole framework providing enhanced security with rate limiting, multi-verification, and advanced access controls for cross-chain token transfers.

**Bitcoin-Backed Native Token**: tBTC tokens on Sei directly backed by Bitcoin custody in Ethereum L1 vault, not by locked L1 tokens. Enables true multichain Bitcoin without liquidity fragmentation.

**BTC Depositor NTT**: Enhanced L1 contract that coordinates Bitcoin deposits with NTT framework for secure cross-chain minting with enterprise-grade controls.

**INttToken Interface**: Standard interface for NTT-compatible tokens enabling mint/burn operations with proper access control integration.

**Rate Limiting**: Advanced security mechanism preventing rapid token drains through configurable daily/hourly limits with automatic queue management.

**Multi-Verification**: NTT capability to require multiple independent verification sources beyond Wormhole Guardians for enhanced security.

**VAA (Verified Action Approval)**: Cryptographically signed message from Wormhole Guardians confirming cross-chain events, enhanced with NTT security layers.

**Transceivers**: Pluggable verification backends in NTT framework, allowing custom security requirements beyond standard Wormhole validation.

## Overview

Deploy **Bitcoin-backed native tBTC** on Sei Network using Wormhole NTT framework for enhanced security, enabling direct Bitcoin → Sei tBTC flow with enterprise-grade controls.

- **Source**: Bitcoin deposits → Ethereum L1 (vault backing)
- **Transport**: Wormhole NTT framework (enhanced security)
- **Destination**: Sei Network (native tBTC tokens)
- **Backing**: Real Bitcoin custody in L1 vault (0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD)

## Architecture Benefits

**Superior to Hub-and-Spoke:**
- **True Bitcoin Backing**: Each tBTC represents real Bitcoin, not locked L1 tokens
- **Native Token Experience**: Full DeFi composability on Sei without wrapped token limitations
- **Unlimited Scalability**: Multiple L2s supported without supply constraints
- **Enhanced Security**: NTT rate limiting and multi-verification on top of Bitcoin backing

**NTT Framework Advantages:**
- **Rate Limiting**: Prevents large-scale token drains
- **Emergency Controls**: Pause mechanisms and access management
- **Multi-Verification**: Optional additional security layers
- **Queue Management**: Automatic handling of large transfers
- **Standardized Interface**: Consistent cross-chain experience

## Technical Architecture

### Ethereum L1 (Bitcoin Coordination)
```
Bitcoin Deposits → tBTC Vault → SeiBTCDepositorNTT → NTT Manager → Cross-chain Message
```

**Components:**
- **Existing tBTC Infrastructure**: Bridge (0x5e4861a80B55f035D899f66772117F00FA0E8e7B), Vault (0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD)
- **SeiBTCDepositorNTT**: Enhanced depositor with NTT integration
- **NTT Manager (Ethereum)**: Rate limiting and enhanced messaging
- **Wormhole Infrastructure**: Core (0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B)

### Sei Network (Native Token Execution)
```
Cross-chain Message → NTT Manager → SeiTBTC (INttToken) → Native Token to User
```

**Components:**
- **SeiTBTC**: Native ERC20 token implementing INttToken interface
- **NTT Manager (Sei)**: Rate limiting, verification, and mint coordination
- **Wormhole Infrastructure**: Core contracts and transceivers

## Smart Contract Implementation

### SeiTBTC (Native Token with NTT Interface)
```solidity
contract SeiTBTC is ERC20, ERC20Permit, INttToken, Ownable, Pausable {
    address public nttManager;
    
    modifier onlyNttManager() {
        require(msg.sender == nttManager, "Only NTT Manager");
        _;
    }
    
    function mint(address to, uint256 amount) external override onlyNttManager whenNotPaused {
        _mint(to, amount);
        emit TokensMinted(to, amount);
    }
    
    function burn(uint256 amount) external override whenNotPaused {
        _burn(msg.sender, amount);
        emit TokensBurned(msg.sender, amount);
    }
    
    function setNttManager(address _nttManager) external onlyOwner {
        nttManager = _nttManager;
        emit NttManagerUpdated(_nttManager);
    }
}
```

### SeiBTCDepositorNTT (L1 Enhanced Coordinator)
```solidity
contract SeiBTCDepositorNTT is BTCDepositorWormhole {
    INttManager public immutable nttManager;
    uint16 public constant SEI_CHAIN_ID = 32;
    
    constructor(
        address _bridge,
        address _vault,
        address _nttManager
    ) BTCDepositorWormhole(_bridge, _vault, _wormhole, _tokenBridge, bytes32(0), SEI_CHAIN_ID) {
        nttManager = INttManager(_nttManager);
    }
    
    function initiateMint(uint256 amount, address recipient) external payable {
        // Coordinate with tBTC vault for Bitcoin backing
        _notifyDepositCompleted(amount);
        
        // Use NTT for enhanced cross-chain transfer
        nttManager.transfer{value: msg.value}(
            amount,
            SEI_CHAIN_ID,
            toWormholeFormat(recipient),
            ""
        );
    }
}
```

## NTT Configuration

### Rate Limiting (Conservative Start)
```json
{
  "inboundLimit": {
    "capacity": "100000000", // 100 tBTC (8 decimals)
    "refillRate": "1157407" // ~1 tBTC per day refill
  },
  "outboundLimit": {
    "capacity": "100000000", // 100 tBTC
    "refillRate": "1157407" // ~1 tBTC per day refill
  }
}
```

### Security Configuration
```json
{
  "transceivers": [
    {
      "address": "0x...", // Wormhole transceiver
      "threshold": 1
    }
  ],
  "pauser": "0x...guardian",
  "owner": "0x...multisig"
}
```

## Deployment Tickets

### Sprint 1: Core Development (6 days)

#### Ticket 1.1: SeiTBTC Native Token Contract
**Priority**: P0 | **Effort**: 2 days | **Assignee**: Solidity Dev

**Description**: Implement native tBTC token with INttToken interface for NTT integration.

**Requirements**:
- [ ] ERC20 token with 8 decimals (Bitcoin standard)
- [ ] INttToken interface implementation (mint/burn/setMinter)
- [ ] Pausable functionality for emergency stops
- [ ] Comprehensive access control (owner, nttManager)
- [ ] Event emissions for monitoring

**Acceptance Criteria**:
- Passes INttToken interface compliance tests
- Only NTT Manager can mint tokens
- Emergency pause prevents all minting/burning
- Proper access control enforcement

#### Ticket 1.2: SeiBTCDepositorNTT L1 Contract
**Priority**: P0 | **Effort**: 2 days | **Assignee**: Solidity Dev

**Description**: Enhanced L1 depositor integrating tBTC vault with NTT framework.

**Requirements**:
- [ ] Extend BTCDepositorWormhole for NTT integration
- [ ] Coordinate Bitcoin deposits with NTT transfers
- [ ] Configure Sei chain ID and NTT Manager integration
- [ ] Maintain existing tBTC vault coordination
- [ ] Add comprehensive error handling

**Acceptance Criteria**:
- Successfully coordinates vault operations with NTT transfers
- Proper integration with existing tBTC infrastructure
- Handles failed transfers gracefully
- Gas-optimized for production use

#### Ticket 1.3: NTT Deployment Scripts
**Priority**: P0 | **Effort**: 2 days | **Assignee**: DevOps Dev

**Description**: Automated deployment scripts for complete NTT system setup.

**Requirements**:
- [ ] Deploy SeiTBTC with proper initialization
- [ ] Deploy and configure NTT Managers on both chains
- [ ] Set up transceivers and security parameters
- [ ] Configure rate limits and access controls
- [ ] Post-deployment verification scripts

**Acceptance Criteria**:
- One-command deployment to any network
- Proper verification of all configurations
- Rate limits and security controls active
- Complete system health check passes

### Sprint 2: Testing & Integration (4 days)

#### Ticket 2.1: Comprehensive Test Suite
**Priority**: P0 | **Effort**: 2 days | **Assignee**: QA Engineer

**Description**: End-to-end testing of Bitcoin → Sei tBTC flow with NTT security.

**Requirements**:
- [ ] Unit tests for all smart contracts
- [ ] Integration tests for cross-chain flows
- [ ] Rate limiting behavior validation
- [ ] Emergency pause scenario testing
- [ ] Performance testing under load

**Acceptance Criteria**:
- 100% code coverage on smart contracts
- All cross-chain scenarios pass
- Rate limits trigger and recover correctly
- Emergency procedures work as expected

#### Ticket 2.2: Testnet Deployment & Validation
**Priority**: P1 | **Effort**: 2 days | **Assignee**: DevOps + QA

**Description**: Deploy complete system on testnets and validate all functionality.

**Requirements**:
- [ ] Deploy on Ethereum Sepolia + Sei testnet
- [ ] Execute full Bitcoin → Sei → Bitcoin round trip
- [ ] Validate NTT rate limiting in realistic scenarios
- [ ] Test all admin functions and emergency procedures
- [ ] Monitor system behavior under various conditions

**Acceptance Criteria**:
- Complete round-trip transactions successful
- Rate limiting behaves correctly under stress
- All emergency procedures function properly
- System ready for mainnet deployment

### Sprint 3: Mainnet Launch (4 days)

#### Ticket 3.1: Mainnet Deployment
**Priority**: P0 | **Effort**: 2 days | **Assignee**: DevOps + Security

**Description**: Production deployment with proper security configuration.

**Requirements**:
- [ ] Deploy contracts to Ethereum mainnet and Sei
- [ ] Configure conservative rate limits for launch
- [ ] Set up multisig ownership and guardian controls
- [ ] Enable monitoring and alerting systems
- [ ] Transfer all administrative controls to proper authorities

**Acceptance Criteria**:
- All contracts deployed and verified
- Rate limits configured conservatively
- Ownership transferred to multisig
- Monitoring systems operational

#### Ticket 3.2: Go-Live & Operations Setup
**Priority**: P1 | **Effort**: 2 days | **Assignee**: Product + DevOps

**Description**: Launch system and establish operational procedures.

**Requirements**:
- [ ] Execute first production transactions
- [ ] Monitor system health and performance
- [ ] Validate rate limiting in production environment
- [ ] Document operational runbooks
- [ ] Train support team on system operations

**Acceptance Criteria**:
- First transactions complete successfully
- All monitoring shows healthy metrics
- Operational procedures documented
- Team ready for production support

## Security Configuration

### Initial Rate Limits (Conservative)
- **Daily Limit**: 100 tBTC (both directions)
- **Per-Transaction Cap**: 10 tBTC
- **Queue Duration**: 24 hours for large transfers
- **Scaling Plan**: Double limits monthly based on usage

### Access Control Hierarchy
- **Owner**: 4/7 multisig for parameter updates
- **Pauser**: Guardian address for emergency stops
- **NTT Manager**: Only entity that can mint/burn tokens
- **Upgrader**: Separate multisig for contract upgrades

### Monitoring & Alerting
- Real-time rate limit usage tracking
- Transfer volume and pattern analysis
- Guardian network health monitoring
- Emergency escalation procedures

## Timeline: 14 Days

**Sprint 1 (Days 1-6)**: Core contract development and deployment automation
**Sprint 2 (Days 7-10)**: Comprehensive testing and testnet validation
**Sprint 3 (Days 11-14)**: Mainnet deployment and operational setup

## Success Metrics

- **Security**: Zero security incidents, proper rate limiting behavior
- **Performance**: <2 minute cross-chain transfer times
- **Adoption**: Successful integration with Sei DeFi protocols
- **Operations**: 99.9% uptime, proper monitoring coverage

This implementation provides Sei users with **Bitcoin-backed native tBTC** enhanced with **enterprise-grade NTT security features**, positioning Sei as the most advanced tBTC deployment across all L2 networks.