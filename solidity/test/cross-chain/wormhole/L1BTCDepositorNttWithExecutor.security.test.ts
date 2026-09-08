import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { BigNumber } from "ethers"
import type {
  L1BTCDepositorNttWithExecutor,
  MockTBTCBridge,
  MockTBTCVault,
  TestERC20,
  MockNttManagerWithExecutor,
  MockNttManager,
} from "../../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

// Wormhole Chain IDs for testing
const WORMHOLE_CHAIN_DESTINATION = 32
const WORMHOLE_CHAIN_BASE = 30

describe("L1BTCDepositorNttWithExecutor - Security Tests", () => {
  let depositor: L1BTCDepositorNttWithExecutor
  let bridge: MockTBTCBridge
  let tbtcVault: MockTBTCVault
  let tbtcToken: TestERC20
  let nttManagerWithExecutor: MockNttManagerWithExecutor
  let underlyingNttManager: MockNttManager

  before(async () => {
    // Deploy mock contracts following working pattern
    const TestERC20Factory = await ethers.getContractFactory("TestERC20")
    tbtcToken = await TestERC20Factory.deploy()

    const MockBridgeFactory = await ethers.getContractFactory("MockTBTCBridge")
    bridge = await MockBridgeFactory.deploy()

    const MockTBTCVaultFactory = await ethers.getContractFactory(
      "contracts/test/MockTBTCVault.sol:MockTBTCVault"
    )
    tbtcVault = (await MockTBTCVaultFactory.deploy()) as MockTBTCVault
    await tbtcVault.setTbtcToken(tbtcToken.address)

    // Deploy proper mock NTT managers
    const MockNttManagerWithExecutorFactory = await ethers.getContractFactory(
      "MockNttManagerWithExecutor"
    )
    nttManagerWithExecutor = await MockNttManagerWithExecutorFactory.deploy()

    const MockNttManagerFactory = await ethers.getContractFactory(
      "MockNttManager"
    )
    underlyingNttManager = await MockNttManagerFactory.deploy()

    await nttManagerWithExecutor.setSupportedChain(
      WORMHOLE_CHAIN_DESTINATION,
      true
    )
    await nttManagerWithExecutor.setSupportedChain(WORMHOLE_CHAIN_BASE, true)

    // Deploy main contract with proxy following working pattern
    const L1BTCDepositorFactory = await ethers.getContractFactory(
      "L1BTCDepositorNttWithExecutor"
    )
    const depositorImpl = await L1BTCDepositorFactory.deploy()
    await depositorImpl.deployed()

    // Deploy proxy
    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy")
    const initData = depositorImpl.interface.encodeFunctionData("initialize", [
      bridge.address,
      tbtcVault.address,
      nttManagerWithExecutor.address,
      underlyingNttManager.address,
    ])
    const proxy = await ProxyFactory.deploy(depositorImpl.address, initData)
    await proxy.deployed()

    depositor = L1BTCDepositorFactory.attach(
      proxy.address
    ) as L1BTCDepositorNttWithExecutor

    // Set up supported chains
    await depositor.setSupportedChain(WORMHOLE_CHAIN_DESTINATION, true)
    await depositor.setSupportedChain(WORMHOLE_CHAIN_BASE, true)
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  describe("Access Control", () => {
    it("should prevent non-owners from updating configuration", async () => {
      const [, , user] = await ethers.getSigners()

      // Non-owner should be reverted when updating default parameters
      await expect(
        depositor
          .connect(user)
          .setDefaultParameters(
            600000,
            50,
            user.address,
            0,
            ethers.constants.AddressZero
          )
      ).to.be.revertedWith("Ownable: caller is not the owner")

      // Non-owner cannot update NTT managers
      await expect(
        depositor.connect(user).updateUnderlyingNttManager(user.address)
      ).to.be.revertedWith("Ownable: caller is not the owner")

      // Non-owner cannot update supported chains
      await expect(
        depositor.connect(user).setSupportedChain(99, true)
      ).to.be.revertedWith("Ownable: caller is not the owner")

      // Non-owner cannot update supported chains (already covered above)
    })

    it("should prevent non-owners from retrieving tokens", async () => {
      const [, , user] = await ethers.getSigners()

      // Send some tokens to the contract
      const amount = ethers.utils.parseEther("1")
      await tbtcToken.mint(depositor.address, amount)

      // Non-owner cannot retrieve tokens
      await expect(
        depositor
          .connect(user)
          .retrieveTokens(tbtcToken.address, user.address, amount)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    // Note: updateReimbursementPool and updateReimbursementAuthorization functions
    // are not available in L1BTCDepositorNttWithExecutor contract
  })

  describe("Input Validation", () => {
    it("should reject invalid executor parameters", async () => {
      const [, , user] = await ethers.getSigners()

      // Empty signed quote should be rejected
      const invalidExecutorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user.address,
        signedQuote: "0x", // Empty quote
        instructions: `0x${"2".repeat(64)}`,
      }

      const feeArgs = {
        dbps: 0,
        payee: ethers.constants.AddressZero,
      }

      await expect(
        depositor
          .connect(user)
          .setExecutorParameters(
            invalidExecutorArgs,
            feeArgs,
            WORMHOLE_CHAIN_DESTINATION
          )
      ).to.be.revertedWith(
        "Real signed quote from Wormhole Executor API is required"
      )
    })

    it("should reject operations on unsupported chains", async () => {
      const [, , user] = await ethers.getSigners()

      const executorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user.address,
        signedQuote: `0x${"1".repeat(128)}`,
        instructions: `0x${"2".repeat(64)}`,
      }

      const feeArgs = {
        dbps: 0,
        payee: ethers.constants.AddressZero,
      }

      await depositor
        .connect(user)
        .setExecutorParameters(
          executorArgs,
          feeArgs,
          WORMHOLE_CHAIN_DESTINATION
        )

      // Try to quote for unsupported chain
      await expect(
        depositor.connect(user)["quoteFinalizeDeposit(uint16)"](999)
      ).to.be.revertedWith("Destination chain not bound to staged parameters")
    })
  })

  describe("State Consistency", () => {
    it("should maintain consistent state during parameter updates", async () => {
      const [, , user] = await ethers.getSigners()

      // Initial state
      const [isSet1] = await depositor.areExecutorParametersSet()
      expect(isSet1).to.be.false
      expect(await depositor.getStoredExecutorValue()).to.equal(0)

      // Set parameters
      const executorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user.address,
        signedQuote: `0x${"1".repeat(128)}`,
        instructions: `0x${"2".repeat(64)}`,
      }

      const feeArgs = {
        dbps: 0,
        payee: ethers.constants.AddressZero,
      }

      await depositor
        .connect(user)
        .setExecutorParameters(
          executorArgs,
          feeArgs,
          WORMHOLE_CHAIN_DESTINATION
        )

      // Check state
      const [isSet2] = await depositor.connect(user).areExecutorParametersSet()
      expect(isSet2).to.be.true
      expect(await depositor.connect(user).getStoredExecutorValue()).to.equal(
        executorArgs.value
      )

      // Clear parameters
      await depositor.connect(user).clearExecutorParameters()

      // State should be reset
      const [isSet3] = await depositor.areExecutorParametersSet()
      expect(isSet3).to.be.false
      expect(await depositor.getStoredExecutorValue()).to.equal(0)
    })

    it("should handle rapid parameter updates correctly", async () => {
      const [, , user] = await ethers.getSigners()

      const feeArgs = {
        dbps: 0,
        payee: ethers.constants.AddressZero,
      }

      // Perform multiple rapid updates
      // eslint-disable-next-line no-plusplus
      for (let i = 0; i < 3; i++) {
        const executorArgs = {
          value: ethers.utils.parseEther(`${i + 1}`),
          refundAddress: user.address,
          signedQuote: `0x${"1".repeat(128)}`,
          instructions: `0x${"2".repeat(64)}`,
        }

        // eslint-disable-next-line no-await-in-loop
        await depositor
          .connect(user)
          .setExecutorParameters(
            executorArgs,
            feeArgs,
            WORMHOLE_CHAIN_DESTINATION
          )

        // eslint-disable-next-line no-await-in-loop
        const [isSet] = await depositor.connect(user).areExecutorParametersSet()
        expect(isSet).to.be.true
        // eslint-disable-next-line no-await-in-loop
        expect(await depositor.connect(user).getStoredExecutorValue()).to.equal(
          ethers.utils.parseEther(`${i + 1}`)
        )
      }
    })
  })

  describe("Edge Cases", () => {
    it("should handle maximum values correctly", async () => {
      const [, , user] = await ethers.getSigners()

      // Set default parameters to allow max fee
      await depositor.setDefaultParameters(
        600000,
        10000,
        user.address,
        0,
        ethers.constants.AddressZero
      )

      // Test with maximum safe amount (MaxUint256 minus 1 ETH to avoid overflow when adding mock base fee)
      const maxAmount = ethers.constants.MaxUint256.sub(
        ethers.utils.parseEther("1")
      )
      const executorArgs = {
        value: maxAmount,
        refundAddress: user.address,
        signedQuote: `0x${"1".repeat(128)}`,
        instructions: `0x${"2".repeat(64)}`,
      }

      const feeArgs = {
        dbps: 10000, // 10% fee in basis points (max allowed)
        payee: user.address,
      }

      await expect(
        depositor
          .connect(user)
          .setExecutorParameters(
            executorArgs,
            feeArgs,
            WORMHOLE_CHAIN_DESTINATION
          )
      ).to.not.be.reverted

      expect(await depositor.connect(user).getStoredExecutorValue()).to.equal(
        maxAmount
      )
    })

    it("should handle zero values correctly", async () => {
      const [, , user] = await ethers.getSigners()

      const executorArgs = {
        value: BigNumber.from(0),
        refundAddress: user.address,
        signedQuote: `0x${"1".repeat(128)}`,
        instructions: `0x${"2".repeat(64)}`,
      }

      const feeArgs = {
        dbps: 0, // 0% fee
        payee: ethers.constants.AddressZero,
      }

      await expect(
        depositor
          .connect(user)
          .setExecutorParameters(
            executorArgs,
            feeArgs,
            WORMHOLE_CHAIN_DESTINATION
          )
      ).to.not.be.reverted

      expect(await depositor.connect(user).getStoredExecutorValue()).to.equal(0)
    })
  })

  describe("Deposit Finalization & Checks-Effects-Interactions Security", () => {
    const MALICIOUS_REENTRANT_RECEIVER_ABI = [
      {
        inputs: [
          {
            internalType: "address",
            name: "_target",
            type: "address",
          },
        ],
        stateMutability: "nonpayable",
        type: "constructor",
      },
      {
        inputs: [],
        name: "attackAttempted",
        outputs: [
          {
            internalType: "bool",
            name: "",
            type: "bool",
          },
        ],
        stateMutability: "view",
        type: "function",
      },
      {
        inputs: [],
        name: "attackDepositKey",
        outputs: [
          {
            internalType: "uint256",
            name: "",
            type: "uint256",
          },
        ],
        stateMutability: "view",
        type: "function",
      },
      {
        inputs: [],
        name: "attackSucceeded",
        outputs: [
          {
            internalType: "bool",
            name: "",
            type: "bool",
          },
        ],
        stateMutability: "view",
        type: "function",
      },
      {
        inputs: [],
        name: "attackValue",
        outputs: [
          {
            internalType: "uint256",
            name: "",
            type: "uint256",
          },
        ],
        stateMutability: "view",
        type: "function",
      },
      {
        inputs: [
          {
            internalType: "uint256",
            name: "depositKey",
            type: "uint256",
          },
        ],
        name: "finalize",
        outputs: [],
        stateMutability: "payable",
        type: "function",
      },
      {
        inputs: [
          {
            components: [
              {
                internalType: "bytes4",
                name: "version",
                type: "bytes4",
              },
              {
                internalType: "bytes",
                name: "inputVector",
                type: "bytes",
              },
              {
                internalType: "bytes",
                name: "outputVector",
                type: "bytes",
              },
              {
                internalType: "bytes4",
                name: "locktime",
                type: "bytes4",
              },
            ],
            internalType: "struct BitcoinTxInfo",
            name: "fundingTx",
            type: "tuple",
          },
          {
            components: [
              {
                internalType: "uint32",
                name: "fundingOutputIndex",
                type: "uint32",
              },
              {
                internalType: "bytes8",
                name: "blindingFactor",
                type: "bytes8",
              },
              {
                internalType: "bytes20",
                name: "walletPubKeyHash",
                type: "bytes20",
              },
              {
                internalType: "bytes20",
                name: "refundPubKeyHash",
                type: "bytes20",
              },
              {
                internalType: "bytes4",
                name: "refundLocktime",
                type: "bytes4",
              },
              {
                internalType: "address",
                name: "vault",
                type: "address",
              },
            ],
            internalType: "struct DepositRevealInfo",
            name: "reveal",
            type: "tuple",
          },
          {
            internalType: "bytes32",
            name: "receiver",
            type: "bytes32",
          },
        ],
        name: "initDeposit",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
      },
      {
        inputs: [],
        name: "lastRevertData",
        outputs: [
          {
            internalType: "bytes",
            name: "",
            type: "bytes",
          },
        ],
        stateMutability: "view",
        type: "function",
      },
      {
        inputs: [
          {
            internalType: "uint256",
            name: "_depositKey",
            type: "uint256",
          },
          {
            internalType: "uint256",
            name: "_value",
            type: "uint256",
          },
          {
            internalType: "bool",
            name: "_bubbleUp",
            type: "bool",
          },
        ],
        name: "setAttackConfig",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
      },
      {
        inputs: [],
        name: "shouldBubbleUpRevert",
        outputs: [
          {
            internalType: "bool",
            name: "",
            type: "bool",
          },
        ],
        stateMutability: "view",
        type: "function",
      },
      {
        inputs: [
          {
            internalType: "uint256",
            name: "value",
            type: "uint256",
          },
          {
            internalType: "bytes",
            name: "signedQuote",
            type: "bytes",
          },
          {
            internalType: "bytes",
            name: "instructions",
            type: "bytes",
          },
          {
            internalType: "uint16",
            name: "destinationChain",
            type: "uint16",
          },
        ],
        name: "stageExecutorParameters",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
      },
      {
        inputs: [],
        name: "target",
        outputs: [
          {
            internalType: "address",
            name: "",
            type: "address",
          },
        ],
        stateMutability: "view",
        type: "function",
      },
      {
        stateMutability: "payable",
        type: "receive",
      },
    ]

    const MALICIOUS_REENTRANT_RECEIVER_BYTECODE =
      "0x608060405234801561001057600080fd5b50604051610e2b380380610e2b83398101604081905261002f91610054565b600080546001600160a01b0319166001600160a01b0392909216919091179055610084565b60006020828403121561006657600080fd5b81516001600160a01b038116811461007d57600080fd5b9392505050565b610d98806100936000396000f3fe6080604052600436106100c05760003560e01c80638833dc2711610074578063bb83bd271161004e578063bb83bd27146102f9578063d4b8399214610318578063de6346021461035057600080fd5b80638833dc27146102a15780638c59507c146102c15780639ca1f61d146102d757600080fd5b8063506c1d3d116100a5578063506c1d3d1461023d578063646eeffc1461025d5780637ea43d501461027d57600080fd5b806305261aea146101fb5780633bb977d81461020e57600080fd5b366101f657600354610100900460ff161580156100e757506000546001600160a01b031615155b156101f4576003805461ff0019166101001790556000805460025460015460405184936001600160a01b031692916101259160240190815260200190565b60408051601f198184030181529181526020820180517bffffffffffffffffffffffffffffffffffffffffffffffffffffffff1663236cea4d60e11b1790525161016f91906106d7565b60006040518083038185875af1925050503d80600081146101ac576040519150601f19603f3d011682016040523d82523d6000602084013e6101b1565b606091505b506003805462ff0000191662010000841515021790559092509050816101f15760046101dd8282610789565b5060035460ff16156101f157805160208201fd5b50505b005b600080fd5b6101f4610209366004610849565b610370565b34801561021a57600080fd5b506003546102289060ff1681565b60405190151581526020015b60405180910390f35b34801561024957600080fd5b506101f4610258366004610862565b6103d3565b34801561026957600080fd5b506101f46102783660046108e9565b610404565b34801561028957600080fd5b5061029360015481565b604051908152602001610234565b3480156102ad57600080fd5b506003546102289062010000900460ff1681565b3480156102cd57600080fd5b5061029360025481565b3480156102e357600080fd5b506102ec61054b565b60405161023491906109a8565b34801561030557600080fd5b5060035461022890610100900460ff1681565b34801561032457600080fd5b50600054610338906001600160a01b031681565b6040516001600160a01b039091168152602001610234565b34801561035c57600080fd5b506101f461036b3660046109c2565b6105d9565b60005460405163236cea4d60e11b8152600481018390526001600160a01b03909116906346d9d49a9034906024016000604051808303818588803b1580156103b757600080fd5b505af11580156103cb573d6000803e3d6000fd5b505050505050565b600183905560028290556003805462ffffff191682151562ffff0019161790556103ff6004600061065d565b505050565b60006040518060800160405280888152602001306001600160a01b0316815260200187878080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250505090825250604080516020601f880181900481028201810190925286815291810191908790879081908401838280828437600092018290525093909452505060408051808201825282815260208101839052915490517fdb43498e00000000000000000000000000000000000000000000000000000000815293945090926001600160a01b03909116915063db43498e906104fd90859085908890600401610a2b565b6020604051808303816000875af115801561051c573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906105409190610ab5565b505050505050505050565b6004805461055890610709565b80601f016020809104026020016040519081016040528092919081815260200182805461058490610709565b80156105d15780601f106105a6576101008083540402835291602001916105d1565b820191906000526020600020905b8154815290600101906020018083116105b457829003601f168201915b505050505081565b6000546040517f6da5658a0000000000000000000000000000000000000000000000000000000081526001600160a01b0390911690636da5658a9061062690869086908690600401610ba6565b600060405180830381600087803b15801561064057600080fd5b505af1158015610654573d6000803e3d6000fd5b50505050505050565b50805461066990610709565b6000825580601f10610679575050565b601f016020900490600052602060002090810190610697919061069a565b50565b5b808211156106af576000815560010161069b565b5090565b60005b838110156106ce5781810151838201526020016106b6565b50506000910152565b600082516106e98184602087016106b3565b9190910192915050565b634e487b7160e01b600052604160045260246000fd5b600181811c9082168061071d57607f821691505b60208210810361073d57634e487b7160e01b600052602260045260246000fd5b50919050565b601f8211156103ff57600081815260208120601f850160051c8101602086101561076a5750805b601f850160051c820191505b818110156103cb57828155600101610776565b815167ffffffffffffffff8111156107a3576107a36106f3565b6107b7816107b18454610709565b84610743565b602080601f8311600181146107ec57600084156107d45750858301515b600019600386901b1c1916600185901b1785556103cb565b600085815260208120601f198616915b8281101561081b578886015182559484019460019091019084016107fc565b50858210156108395787850151600019600388901b60f8161c191681555b5050505050600190811b01905550565b60006020828403121561085b57600080fd5b5035919050565b60008060006060848603121561087757600080fd5b83359250602084013591506040840135801515811461089557600080fd5b809150509250925092565b60008083601f8401126108b257600080fd5b50813567ffffffffffffffff8111156108ca57600080fd5b6020830191508360208285010111156108e257600080fd5b9250929050565b6000806000806000806080878903121561090257600080fd5b86359550602087013567ffffffffffffffff8082111561092157600080fd5b61092d8a838b016108a0565b9097509550604089013591508082111561094657600080fd5b5061095389828a016108a0565b909450925050606087013561ffff8116811461096e57600080fd5b809150509295509295509295565b600081518084526109948160208601602086016106b3565b601f01601f19169290920160200192915050565b6020815260006109bb602083018461097c565b9392505050565b60008060008385036101008112156109d957600080fd5b843567ffffffffffffffff8111156109f057600080fd5b850160808188031215610a0257600080fd5b935060c0601f1982011215610a1657600080fd5b5060208401915060e084013590509250925092565b6080815283516080820152600060208501516001600160a01b0380821660a085015260408701519150608060c0850152610a6961010085018361097c565b91506060870151607f198584030160e0860152610a86838261097c565b93505061ffff915081865116602085015280602087015116604085015250808416606084015250949350505050565b600060208284031215610ac757600080fd5b5051919050565b80357fffffffff0000000000000000000000000000000000000000000000000000000081168114610afe57600080fd5b919050565b6000808335601e19843603018112610b1a57600080fd5b830160208101925035905067ffffffffffffffff811115610b3a57600080fd5b8036038213156108e257600080fd5b81835281816020850137506000828201602090810191909152601f909101601f19169091010190565b80356bffffffffffffffffffffffff1981168114610afe57600080fd5b80356001600160a01b0381168114610afe57600080fd5b60006101008083527fffffffff0000000000000000000000000000000000000000000000000000000080610bd988610ace565b1682850152610beb6020880188610b03565b92506080610120860152610c0461018086018483610b49565b925050610c146040880188610b03565b85840360ff1901610140870152610c2c848284610b49565b9350505080610c3d60608901610ace565b16610160850152509050833563ffffffff8116808214610c5c57600080fd5b806020850152505060208401357fffffffffffffffff00000000000000000000000000000000000000000000000081168114610c9757600080fd5b7fffffffffffffffff0000000000000000000000000000000000000000000000008116604084015250610ccc60408501610b72565b6bffffffffffffffffffffffff198116606084015250610cee60608501610b72565b6bffffffffffffffffffffffff198116608084015250610d1060808501610ace565b7fffffffff00000000000000000000000000000000000000000000000000000000811660a084015250610d4560a08501610b8f565b6001600160a01b031660c083015260e0909101919091529291505056fea2646970667358221220d21f34e55c4d1fcfbdb0dbc8b6130e5d9f7196e4a2dd95601cc5991933a8c50d64736f6c63430008110033"

    const decodeRevertReason = (data: string): string => {
      if (!data || data.length < 138) return ""
      const reasonData = "0x" + data.slice(10)
      return ethers.utils.defaultAbiCoder.decode(["string"], reasonData)[0]
    }

    const fundingTx = {
      version: "0x01000000",
      inputVector: "0x01",
      outputVector: "0x02",
      locktime: "0x00000000",
    }

    it("should finalize deposit end-to-end and clear staged parameters from storage", async () => {
      const [, , user] = await ethers.getSigners()

      // 1. Stage executor parameters
      const executorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user.address,
        signedQuote: `0x${"1".repeat(128)}`,
        instructions: `0x${"2".repeat(64)}`,
      }
      const feeArgs = {
        dbps: 0,
        payee: ethers.constants.AddressZero,
      }

      await depositor
        .connect(user)
        .setExecutorParameters(
          executorArgs,
          feeArgs,
          WORMHOLE_CHAIN_DESTINATION
        )

      const requiredPayment = await depositor
        .connect(user)
        ["quoteFinalizeDeposit(uint16)"](WORMHOLE_CHAIN_DESTINATION)

      const receiver = ethers.utils.hexConcat([
        ethers.utils.hexZeroPad(
          ethers.utils.hexlify(WORMHOLE_CHAIN_DESTINATION),
          2
        ),
        ethers.utils.hexZeroPad(user.address, 30),
      ])

      const reveal = {
        fundingOutputIndex: 0,
        blindingFactor: "0xba863847d2d0fee3",
        walletPubKeyHash: "0xf997563fee8610ca28f99ac05bd8a29506800d4d",
        refundPubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
        refundLocktime: "0xde2b4c67",
        vault: tbtcVault.address,
      }

      // 2. Initialize deposit
      const tx = await depositor
        .connect(user)
        .initializeDeposit(fundingTx, reveal, receiver)
      const receipt = await tx.wait()
      const depositKey = receipt.events?.find(
        (e) => e.event === "DepositInitialized"
      )?.args?.depositKey

      // Verify parameters are set before finalization
      const [isSetBefore, nonceBefore] = await depositor
        .connect(user)
        .areExecutorParametersSet()
      expect(isSetBefore).to.be.true
      expect(nonceBefore).to.not.equal(ethers.constants.HashZero)
      expect(await depositor.connect(user).getStoredExecutorValue()).to.equal(
        executorArgs.value
      )

      // 3. Finalize deposit end-to-end
      await expect(
        depositor
          .connect(user)
          .finalizeDeposit(depositKey, { value: requiredPayment })
      ).to.emit(depositor, "TokensTransferredNttWithExecutor")

      // 4. Verify nonce storage is cleared after finalization
      const [isSetAfter] = await depositor
        .connect(user)
        .areExecutorParametersSet()
      expect(isSetAfter).to.be.false
      expect(await depositor.connect(user).getStoredExecutorValue()).to.equal(0)

      const [hasActiveWorkflow] = await depositor.getUserWorkflowStatus(
        user.address
      )
      expect(hasActiveWorkflow).to.be.false
      expect(await depositor.canUserStartNewWorkflow(user.address)).to.be.true

      // 5. Calling finalizeDeposit again on the same finalized deposit reverts
      await expect(
        depositor
          .connect(user)
          .finalizeDeposit(depositKey, { value: requiredPayment })
      ).to.be.revertedWith("Wrong deposit state")

      // 6. Calling finalizeDeposit on another deposit with same nonce without re-staging reverts
      const reveal2 = { ...reveal, fundingOutputIndex: 1 }
      const tx2 = await depositor
        .connect(user)
        .initializeDeposit(fundingTx, reveal2, receiver)
      const receipt2 = await tx2.wait()
      const depositKey2 = receipt2.events?.find(
        (e) => e.event === "DepositInitialized"
      )?.args?.depositKey

      await expect(
        depositor
          .connect(user)
          .finalizeDeposit(depositKey2, { value: requiredPayment })
      ).to.be.revertedWith("Executor parameters not set")
    })

    it("should prevent reentrancy during ETH refund step when attacking same deposit", async () => {
      const [, , attackerSigner] = await ethers.getSigners()

      // Deploy MaliciousReentrantRefundReceiver
      const MaliciousFactory = new ethers.ContractFactory(
        MALICIOUS_REENTRANT_RECEIVER_ABI,
        MALICIOUS_REENTRANT_RECEIVER_BYTECODE,
        attackerSigner
      )
      const maliciousReceiver = await MaliciousFactory.deploy(depositor.address)
      await maliciousReceiver.deployed()

      // Stage parameters from maliciousReceiver contract so msg.sender == refundAddress
      const signedQuote = `0x${"1".repeat(128)}`
      const instructions = `0x${"2".repeat(64)}`
      const executorValue = ethers.utils.parseEther("0.01")

      await maliciousReceiver.stageExecutorParameters(
        executorValue,
        signedQuote,
        instructions,
        WORMHOLE_CHAIN_DESTINATION
      )

      const requiredPayment = await nttManagerWithExecutor.quoteDeliveryPrice(
        underlyingNttManager.address,
        WORMHOLE_CHAIN_DESTINATION,
        "0x",
        {
          value: executorValue,
          refundAddress: maliciousReceiver.address,
          signedQuote,
          instructions,
        },
        {
          dbps: 0,
          payee: ethers.constants.AddressZero,
        }
      )

      const receiver = ethers.utils.hexConcat([
        ethers.utils.hexZeroPad(
          ethers.utils.hexlify(WORMHOLE_CHAIN_DESTINATION),
          2
        ),
        ethers.utils.hexZeroPad(maliciousReceiver.address, 30),
      ])

      const reveal = {
        fundingOutputIndex: 0,
        blindingFactor: "0xba863847d2d0fee3",
        walletPubKeyHash: "0xf997563fee8610ca28f99ac05bd8a29506800d4d",
        refundPubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
        refundLocktime: "0xde2b4c67",
        vault: tbtcVault.address,
      }

      const tx = await depositor
        .connect(attackerSigner)
        .initializeDeposit(fundingTx, reveal, receiver)
      const receipt = await tx.wait()
      const depositKey = receipt.events?.find(
        (e) => e.event === "DepositInitialized"
      )?.args?.depositKey

      // Configure malicious receiver to re-enter finalizeDeposit on the same depositKey during refund
      await maliciousReceiver.setAttackConfig(depositKey, 0, false)

      // Finalize deposit through malicious receiver - during external refund to maliciousReceiver, receive() re-enters finalizeDeposit
      await maliciousReceiver.finalize(depositKey, {
        value: requiredPayment,
        gasLimit: 2_000_000,
      })

      // Verify reentrancy was attempted and failed due to Checks-Effects-Interactions deposit state
      expect(await maliciousReceiver.attackAttempted()).to.be.true
      expect(await maliciousReceiver.attackSucceeded()).to.be.false
      const revertReason = decodeRevertReason(
        await maliciousReceiver.lastRevertData()
      )
      expect(revertReason).to.equal("Wrong deposit state")
    })

    it("should prevent reentrancy parameter reuse during ETH refund step on second deposit", async () => {
      const [, , attackerSigner] = await ethers.getSigners()

      // Deploy MaliciousReentrantRefundReceiver
      const MaliciousFactory = new ethers.ContractFactory(
        MALICIOUS_REENTRANT_RECEIVER_ABI,
        MALICIOUS_REENTRANT_RECEIVER_BYTECODE,
        attackerSigner
      )
      const maliciousReceiver = await MaliciousFactory.deploy(depositor.address)
      await maliciousReceiver.deployed()

      // Stage executor parameters once for maliciousReceiver
      const signedQuote = `0x${"1".repeat(128)}`
      const instructions = `0x${"2".repeat(64)}`
      const executorValue = ethers.utils.parseEther("0.01")

      await maliciousReceiver.stageExecutorParameters(
        executorValue,
        signedQuote,
        instructions,
        WORMHOLE_CHAIN_DESTINATION
      )

      const requiredPayment = await nttManagerWithExecutor.quoteDeliveryPrice(
        underlyingNttManager.address,
        WORMHOLE_CHAIN_DESTINATION,
        "0x",
        {
          value: executorValue,
          refundAddress: maliciousReceiver.address,
          signedQuote,
          instructions,
        },
        {
          dbps: 0,
          payee: ethers.constants.AddressZero,
        }
      )

      const receiver = ethers.utils.hexConcat([
        ethers.utils.hexZeroPad(
          ethers.utils.hexlify(WORMHOLE_CHAIN_DESTINATION),
          2
        ),
        ethers.utils.hexZeroPad(maliciousReceiver.address, 30),
      ])

      // Initialize two deposits
      const reveal1 = {
        fundingOutputIndex: 0,
        blindingFactor: "0xba863847d2d0fee3",
        walletPubKeyHash: "0xf997563fee8610ca28f99ac05bd8a29506800d4d",
        refundPubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
        refundLocktime: "0xde2b4c67",
        vault: tbtcVault.address,
      }
      const tx1 = await depositor
        .connect(attackerSigner)
        .initializeDeposit(fundingTx, reveal1, receiver)
      const receipt1 = await tx1.wait()
      const depositKey1 = receipt1.events?.find(
        (e) => e.event === "DepositInitialized"
      )?.args?.depositKey

      const reveal2 = {
        fundingOutputIndex: 1,
        blindingFactor: "0xba863847d2d0fee3",
        walletPubKeyHash: "0xf997563fee8610ca28f99ac05bd8a29506800d4d",
        refundPubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
        refundLocktime: "0xde2b4c67",
        vault: tbtcVault.address,
      }
      const tx2 = await depositor
        .connect(attackerSigner)
        .initializeDeposit(fundingTx, reveal2, receiver)
      const receipt2 = await tx2.wait()
      const depositKey2 = receipt2.events?.find(
        (e) => e.event === "DepositInitialized"
      )?.args?.depositKey

      // Configure malicious receiver to attempt finalizing depositKey2 during depositKey1's refund
      await maliciousReceiver.setAttackConfig(depositKey2, 0, false)

      // Finalize depositKey1 through maliciousReceiver
      await maliciousReceiver.finalize(depositKey1, {
        value: requiredPayment,
        gasLimit: 2_000_000,
      })

      // Verify reentrancy attempt was blocked by deleted parametersByNonce (PR #1031 CEI fix)
      expect(await maliciousReceiver.attackAttempted()).to.be.true
      expect(await maliciousReceiver.attackSucceeded()).to.be.false
      const revertReason = decodeRevertReason(
        await maliciousReceiver.lastRevertData()
      )
      expect(revertReason).to.equal("Executor parameters not set")
    })

    it("should revert top-level finalizeDeposit when reentrant call bubbles up revert on refund", async () => {
      const [, , attackerSigner] = await ethers.getSigners()

      // Deploy MaliciousReentrantRefundReceiver
      const MaliciousFactory = new ethers.ContractFactory(
        MALICIOUS_REENTRANT_RECEIVER_ABI,
        MALICIOUS_REENTRANT_RECEIVER_BYTECODE,
        attackerSigner
      )
      const maliciousReceiver = await MaliciousFactory.deploy(depositor.address)
      await maliciousReceiver.deployed()

      // Stage executor parameters from maliciousReceiver
      const signedQuote = `0x${"1".repeat(128)}`
      const instructions = `0x${"2".repeat(64)}`
      const executorValue = ethers.utils.parseEther("0.01")

      await maliciousReceiver.stageExecutorParameters(
        executorValue,
        signedQuote,
        instructions,
        WORMHOLE_CHAIN_DESTINATION
      )

      const requiredPayment = await nttManagerWithExecutor.quoteDeliveryPrice(
        underlyingNttManager.address,
        WORMHOLE_CHAIN_DESTINATION,
        "0x",
        {
          value: executorValue,
          refundAddress: maliciousReceiver.address,
          signedQuote,
          instructions,
        },
        {
          dbps: 0,
          payee: ethers.constants.AddressZero,
        }
      )

      const receiver = ethers.utils.hexConcat([
        ethers.utils.hexZeroPad(
          ethers.utils.hexlify(WORMHOLE_CHAIN_DESTINATION),
          2
        ),
        ethers.utils.hexZeroPad(maliciousReceiver.address, 30),
      ])

      const reveal = {
        fundingOutputIndex: 0,
        blindingFactor: "0xba863847d2d0fee3",
        walletPubKeyHash: "0xf997563fee8610ca28f99ac05bd8a29506800d4d",
        refundPubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
        refundLocktime: "0xde2b4c67",
        vault: tbtcVault.address,
      }

      const tx = await depositor
        .connect(attackerSigner)
        .initializeDeposit(fundingTx, reveal, receiver)
      const receipt = await tx.wait()
      const depositKey = receipt.events?.find(
        (e) => e.event === "DepositInitialized"
      )?.args?.depositKey

      // Configure malicious receiver with bubbleUp = true
      await maliciousReceiver.setAttackConfig(depositKey, 0, true)

      // When the reentrant call fails ("Wrong deposit state") and bubbles up, MockNttManagerWithExecutor refund fails
      await expect(
        maliciousReceiver.finalize(depositKey, {
          value: requiredPayment,
          gasLimit: 2_000_000,
        })
      ).to.be.revertedWith("Refund failed")
    })
  })
})
