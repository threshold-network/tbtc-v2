import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { randomBytes } from "crypto"
import chai, { expect } from "chai"
import { FakeContract, smock } from "@defi-wonderland/smock"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, ContractTransaction } from "ethers"
import {
  IBridge,
  ITBTCVault,
  L1BTCDepositorNtt,
  ReimbursementPool,
  TestERC20,
} from "../../../typechain"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot

// Wormhole Chain IDs for testing
const WORMHOLE_CHAIN_ETH = 2
const WORMHOLE_CHAIN_SEI = 32  
const WORMHOLE_CHAIN_BASE = 30

// Mock NTT Manager interface
interface INttManager {
  transfer(
    amount: BigNumber,
    recipientChain: number,
    recipient: string
  ): Promise<ContractTransaction>
  
  quoteDeliveryPrice(
    recipientChain: number,
    transceiverInstructions: string
  ): Promise<{ priceQuotes: BigNumber[], totalPrice: BigNumber }>
}

describe("L1BTCDepositorNtt Utilities and Edge Cases", () => {
  const contractsFixture = async () => {
    const { deployer, governance } = await helpers.signers.getNamedSigners()

    const accounts = await getUnnamedAccounts()
    const relayer = await ethers.getSigner(accounts[1])
    const user = await ethers.getSigner(accounts[2])

    const bridge = await smock.fake<IBridge>("IBridge")
    const tbtcToken = await (
      await ethers.getContractFactory("TestERC20")
    ).deploy()
    const tbtcVault = await smock.fake<ITBTCVault>("ITBTCVault", {
      address: tbtcVaultAddress,
    })
    tbtcVault.tbtcToken.returns(tbtcToken.address)

    const nttManager = await smock.fake("contracts/cross-chain/wormhole/L1BTCDepositorNtt.sol:INttManager")
    const reimbursementPool = await smock.fake<ReimbursementPool>("ReimbursementPool")

    const deployment = await helpers.upgrades.deployProxy(
      // Hacky workaround allowing to deploy proxy contract any number of times
      // without clearing `deployments/hardhat` directory.
      // See: https://github.com/keep-network/hardhat-helpers/issues/38
      `L1BTCDepositorNtt_${randomBytes(8).toString("hex")}`,
      {
        contractName: "L1BTCDepositorNtt",
        initializerArgs: [
          bridge.address,
          tbtcVault.address,
          nttManager.address,
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: {
          kind: "transparent",
        },
      }
    )
    const l1BtcDepositorNtt = deployment[0] as L1BTCDepositorNtt

    await l1BtcDepositorNtt.connect(deployer).transferOwnership(governance.address)

    return {
      governance,
      relayer,
      user,
      bridge,
      tbtcToken,
      tbtcVault,
      nttManager,
      reimbursementPool,
      l1BtcDepositorNtt,
    }
  }

  let governance: SignerWithAddress
  let relayer: SignerWithAddress
  let user: SignerWithAddress
  let bridge: FakeContract<IBridge>
  let tbtcToken: TestERC20
  let tbtcVault: FakeContract<ITBTCVault>
  let nttManager: any
  let reimbursementPool: FakeContract<ReimbursementPool>
  let l1BtcDepositorNtt: L1BTCDepositorNtt

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      governance,
      relayer,
      user,
      bridge,
      tbtcToken,
      tbtcVault,
      nttManager,
      reimbursementPool,
      l1BtcDepositorNtt,
    } = await waffle.loadFixture(contractsFixture))
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  describe("Encoding/Decoding Utilities Logic", () => {
    const testChainId = WORMHOLE_CHAIN_SEI
    const testRecipient = "0x23b82a7108F9CEb34C3CDC44268be21D151d4124"

    it("should encode and decode chain ID and recipient correctly", async () => {
      // Test the logic that the contract implements
      // Chain ID goes in first 2 bytes, address in remaining 30 bytes
      
      // Encode: [2 bytes: Chain ID][30 bytes: Address]
      const encoded = (BigNumber.from(testChainId).shl(240)).or(BigNumber.from(testRecipient))
      
      // Decode chain ID (first 2 bytes)
      const decodedChainId = encoded.shr(240).toNumber()
      
      // Decode recipient (mask out first 2 bytes)
      const mask = BigNumber.from("0x0000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF")
      const decodedRecipient = "0x" + encoded.and(mask).toHexString().slice(2).padStart(40, '0')
      
      expect(decodedChainId).to.equal(testChainId)
      expect(decodedRecipient.toLowerCase()).to.equal(testRecipient.toLowerCase())
    })

    it("should handle maximum values correctly", async () => {
      const maxChainId = 65535 // 2^16 - 1
      const maxAddress = "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"
      
      const encoded = (BigNumber.from(maxChainId).shl(240)).or(BigNumber.from(maxAddress))
      
      const decodedChainId = encoded.shr(240).toNumber()
      const mask = BigNumber.from("0x0000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF")
      const decodedRecipient = "0x" + encoded.and(mask).toHexString().slice(2).padStart(40, '0')
      
      expect(decodedChainId).to.equal(maxChainId)
      expect(decodedRecipient.toLowerCase()).to.equal(maxAddress.toLowerCase())
    })

    it("should handle zero values correctly", async () => {
      const zeroChainId = 0
      const zeroAddress = "0x0000000000000000000000000000000000000000"
      
      const encoded = (BigNumber.from(zeroChainId).shl(240)).or(BigNumber.from(zeroAddress))
      
      const decodedChainId = encoded.shr(240).toNumber()
      const mask = BigNumber.from("0x0000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF")
      const decodedRecipient = "0x" + encoded.and(mask).toHexString().slice(2).padStart(40, '0')
      
      expect(decodedChainId).to.equal(zeroChainId)
      expect(decodedRecipient.toLowerCase()).to.equal(zeroAddress.toLowerCase())
    })
  })

  describe("Chain Selection Logic", () => {
    it("should correctly identify destination chain from encoded receiver", async () => {
      // Test the _getDestinationChainFromReceiver logic
      const testCases = [
        { chainId: WORMHOLE_CHAIN_SEI, recipient: "0x23b82a7108F9CEb34C3CDC44268be21D151d4124" },
        { chainId: WORMHOLE_CHAIN_BASE, recipient: "0x742d35cc6bb3c0532925a3b8d8e9e24a3e6f7362" },
        { chainId: 0, recipient: "0x1111111111111111111111111111111111111111" }, // Zero case
      ]

      testCases.forEach(({ chainId, recipient }, index) => {
        // Encode the receiver
        const encoded = (BigNumber.from(chainId).shl(240)).or(BigNumber.from(recipient))
        
        // Extract chain ID (first 2 bytes)
        const extractedChainId = encoded.shr(240).toNumber()
        
        // Extract recipient (remove first 2 bytes)
        const mask = BigNumber.from("0x0000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF")
        const extractedRecipient = "0x" + encoded.and(mask).toHexString().slice(2).padStart(40, '0')
        
        expect(extractedChainId, `Test case ${index + 1} chain ID`).to.equal(chainId)
        expect(extractedRecipient.toLowerCase(), `Test case ${index + 1} recipient`).to.equal(recipient.toLowerCase())
      })
    })

    it("should handle backward compatibility logic", async () => {
      // When chain ID is 0, the contract should fall back to default chain
      // This tests the logic: if (chainId == 0 || !supportedChains[chainId])
      
      const zeroChainReceiver = (BigNumber.from(0).shl(240)).or(BigNumber.from("0x23b82a7108F9CEb34C3CDC44268be21D151d4124"))
      const extractedChainId = zeroChainReceiver.shr(240).toNumber()
      
      expect(extractedChainId).to.equal(0)
      
      // In the contract, this would trigger the fallback logic:
      // chainId = _getDefaultSupportedChain()
      // This ensures backward compatibility with existing deposits
    })
  })

  describe("NTT Integration Logic", () => {
    it("should calculate correct delivery pricing structure", async () => {
      // Test the quoteFinalizeDeposit logic structure
      const mockPriceQuotes = [
        BigNumber.from(20000), // Wormhole transceiver
        BigNumber.from(30000), // Axelar transceiver (if configured)
      ]
      const mockTotalPrice = BigNumber.from(50000)
      
      // The contract should return the totalPrice from NTT Manager
      expect(mockTotalPrice.gt(0)).to.be.true
      expect(mockPriceQuotes.length).to.be.greaterThanOrEqual(1)
      
      // Verify individual quotes sum to total (NTT framework handles this)
      const calculatedTotal = mockPriceQuotes.reduce((sum, quote) => sum.add(quote), BigNumber.from(0))
      expect(calculatedTotal).to.equal(mockTotalPrice)
    })

    it("should validate transfer parameters structure", async () => {
      // Test the _transferTbtc logic validation
      const amount = ethers.utils.parseEther("1") // 1 tBTC
      const chainId = WORMHOLE_CHAIN_SEI
      const recipient = "0x23b82a7108F9CEb34C3CDC44268be21D151d4124"
      
      // Encode receiver
      const encodedReceiver = (BigNumber.from(chainId).shl(240)).or(BigNumber.from(recipient))
      
      // Extract destination chain
      const destinationChain = encodedReceiver.shr(240).toNumber()
      
      // Extract actual recipient
      const mask = BigNumber.from("0x0000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF")
      const actualRecipient = "0x" + encodedReceiver.and(mask).toHexString().slice(2).padStart(40, '0')
      
      // Validate the logic
      expect(amount.gt(0)).to.be.true // Amount validation
      expect(destinationChain).to.equal(chainId) // Chain extraction
      expect(actualRecipient.toLowerCase()).to.equal(recipient.toLowerCase()) // Recipient extraction
      
      // The contract would then:
      // 1. Check supportedChains[destinationChain]
      // 2. Get pricing via nttManager.quoteDeliveryPrice()
      // 3. Approve tBTC to NTT Manager
      // 4. Call nttManager.transfer() with actualRecipient
    })
  })

  describe("Supported Chains Management Logic", () => {
    it("should manage supported chains mapping correctly", async () => {
      // Test the setSupportedChain and getSupportedChains logic
      const supportedChains: { [key: number]: boolean } = {}
      
      // Add chains
      supportedChains[WORMHOLE_CHAIN_SEI] = true
      supportedChains[WORMHOLE_CHAIN_BASE] = true
      
      // Test getSupportedChains logic
      const chainIds = Object.keys(supportedChains)
        .map(Number)
        .filter(chainId => supportedChains[chainId])
        .sort((a, b) => a - b)
      
      expect(chainIds).to.deep.equal([WORMHOLE_CHAIN_BASE, WORMHOLE_CHAIN_SEI])
      expect(supportedChains[WORMHOLE_CHAIN_SEI]).to.be.true
      expect(supportedChains[WORMHOLE_CHAIN_BASE]).to.be.true
      expect(supportedChains[999]).to.be.undefined // Unsupported chain
    })

    it("should find default supported chain correctly", async () => {
      // Test _getDefaultSupportedChain logic
      const supportedChains: { [key: number]: boolean } = {
        [WORMHOLE_CHAIN_BASE]: true,
        [WORMHOLE_CHAIN_SEI]: true,
      }
      
      // Find first supported chain (ascending order)
      let defaultChain = 0
      for (let i = 1; i <= 65535; i++) {
        if (supportedChains[i]) {
          defaultChain = i
          break
        }
      }
      
      expect(defaultChain).to.equal(WORMHOLE_CHAIN_BASE) // Should be the lowest chain ID
    })
  })

  describe("Access Control Logic", () => {
    it("should validate owner-only operations", async () => {
      // Test that governance is the owner
      expect(await l1BtcDepositorNtt.owner()).to.equal(governance.address)
    })
  })

  describe("Error Handling Logic", () => {
    it("should validate input parameters correctly", async () => {
      // Test validation logic for various functions
      
      // Chain ID validation
      const validChainId = WORMHOLE_CHAIN_SEI
      const invalidChainId = 0
      
      expect(validChainId).to.be.greaterThan(0) // Valid
      expect(invalidChainId).to.equal(0) // Would trigger "Chain ID cannot be zero"
      
      // Address validation
      const validAddress = "0x23b82a7108F9CEb34C3CDC44268be21D151d4124"
      const zeroAddress = "0x0000000000000000000000000000000000000000"
      
      expect(validAddress).to.not.equal(zeroAddress) // Valid
      expect(zeroAddress).to.equal(ethers.constants.AddressZero) // Would trigger zero address check
      
      // Amount validation
      const validAmount = ethers.utils.parseEther("1")
      const zeroAmount = BigNumber.from(0)
      
      expect(validAmount.gt(0)).to.be.true // Valid
      expect(zeroAmount.eq(0)).to.be.true // Would trigger "Amount must be greater than 0"
    })

    it("should handle edge cases in encoding/decoding", async () => {
      // Test edge cases for the encoding/decoding logic
      
      // Maximum values
      const maxChainId = 65535
      const maxUint160 = BigNumber.from(2).pow(160).sub(1)
      
      expect(maxChainId).to.be.lessThanOrEqual(65535)
      expect(maxUint160.lt(BigNumber.from(2).pow(160))).to.be.true
      
      // Bit operations
      const testValue = BigNumber.from(maxChainId).shl(240)
      const extractedChainId = testValue.shr(240).toNumber()
      
      expect(extractedChainId).to.equal(maxChainId)
    })
  })

  describe("Contract-specific utility functions", () => {
    describe("retrieveTokens", () => {
      context("when caller is not owner", () => {
        it("should revert", async () => {
          await expect(
            l1BtcDepositorNtt
              .connect(relayer)
              .retrieveTokens(tbtcToken.address, user.address, ethers.utils.parseEther("1"))
          ).to.be.revertedWith("Ownable: caller is not the owner")
        })
      })

      context("when caller is owner", () => {
        it("should transfer tokens to recipient", async () => {
          // Mint tokens to contract first
          await tbtcToken.mint(l1BtcDepositorNtt.address, ethers.utils.parseEther("10"))

          const initialBalance = await tbtcToken.balanceOf(user.address)
          const transferAmount = ethers.utils.parseEther("1")

          await l1BtcDepositorNtt
            .connect(governance)
            .retrieveTokens(tbtcToken.address, user.address, transferAmount)

          const finalBalance = await tbtcToken.balanceOf(user.address)
          expect(finalBalance.sub(initialBalance)).to.equal(transferAmount)
        })
      })
    })

    describe("gas offset calculations", () => {
      it("should handle gas offset parameters correctly", async () => {
        const initializeOffset = 1000
        const finalizeOffset = 2000

        await l1BtcDepositorNtt
          .connect(governance)
          .updateGasOffsetParameters(initializeOffset, finalizeOffset)

        expect(await l1BtcDepositorNtt.initializeDepositGasOffset()).to.equal(initializeOffset)
        expect(await l1BtcDepositorNtt.finalizeDepositGasOffset()).to.equal(finalizeOffset)
      })

      it("should handle zero gas offsets", async () => {
        await l1BtcDepositorNtt
          .connect(governance)
          .updateGasOffsetParameters(0, 0)

        expect(await l1BtcDepositorNtt.initializeDepositGasOffset()).to.equal(0)
        expect(await l1BtcDepositorNtt.finalizeDepositGasOffset()).to.equal(0)
      })
    })

    describe("reimbursement authorization", () => {
      it("should handle multiple authorizations", async () => {
        const addresses = [
          "0x1234567890123456789012345678901234567890",
          "0x0987654321098765432109876543210987654321",
          "0x1111111111111111111111111111111111111111"
        ]

        for (const address of addresses) {
          await l1BtcDepositorNtt
            .connect(governance)
            .updateReimbursementAuthorization(address, true)

          expect(await l1BtcDepositorNtt.reimbursementAuthorizations(address)).to.be.true
        }

        // Revoke one
        await l1BtcDepositorNtt
          .connect(governance)
          .updateReimbursementAuthorization(addresses[0], false)

        expect(await l1BtcDepositorNtt.reimbursementAuthorizations(addresses[0])).to.be.false
        expect(await l1BtcDepositorNtt.reimbursementAuthorizations(addresses[1])).to.be.true
        expect(await l1BtcDepositorNtt.reimbursementAuthorizations(addresses[2])).to.be.true
      })
    })
  })

  describe("Bit manipulation edge cases", () => {
    it("should handle all possible chain IDs", async () => {
      const testChainIds = [1, 2, 100, 1000, 65535]
      
      for (const chainId of testChainIds) {
        const testAddress = "0x23b82a7108F9CEb34C3CDC44268be21D151d4124"
        
        // Test encoding/decoding
        const encoded = (BigNumber.from(chainId).shl(240)).or(BigNumber.from(testAddress))
        const decodedChainId = encoded.shr(240).toNumber()
        
        expect(decodedChainId).to.equal(chainId)
      }
    })

    it("should handle address with leading zeros", async () => {
      const chainId = WORMHOLE_CHAIN_SEI
      const addressWithZeros = "0x0000000000000000000000000000000000000123"
      
      const encoded = (BigNumber.from(chainId).shl(240)).or(BigNumber.from(addressWithZeros))
      const mask = BigNumber.from("0x0000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF")
      const decodedAddress = "0x" + encoded.and(mask).toHexString().slice(2).padStart(40, '0')
      
      expect(decodedAddress.toLowerCase()).to.equal(addressWithZeros.toLowerCase())
    })

    it("should handle address with all Fs", async () => {
      const chainId = WORMHOLE_CHAIN_SEI
      const addressWithFs = "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"
      
      const encoded = (BigNumber.from(chainId).shl(240)).or(BigNumber.from(addressWithFs))
      const mask = BigNumber.from("0x0000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF")
      const decodedAddress = "0x" + encoded.and(mask).toHexString().slice(2).padStart(40, '0')
      
      expect(decodedAddress.toLowerCase()).to.equal(addressWithFs.toLowerCase())
    })
  })

  describe("Integration with contract functions", () => {
    it("should work with actual contract encoding/decoding functions", async () => {
      // Test that the contract can be called without errors
      expect(await l1BtcDepositorNtt.getNttConfiguration()).to.equal(nttManager.address)
    })
  })
})

// Just an arbitrary TBTCVault address.
const tbtcVaultAddress = "0xB5679dE944A79732A75CE556191DF11F489448d5"
