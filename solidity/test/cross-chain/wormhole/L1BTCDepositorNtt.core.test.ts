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
import type {
  BitcoinTxInfoStruct,
  DepositRevealInfoStruct,
} from "../../../typechain/L2BTCDepositorWormhole"
import { to1ePrecision } from "../../helpers/contract-test-helpers"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime } = helpers.time

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
  ): Promise<{ priceQuotes: BigNumber[]; totalPrice: BigNumber }>
}

describe("L1BTCDepositorNtt Core Functions", () => {
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

    const nttManager = {
      address: ethers.Wallet.createRandom().address,
      // Add proper function signatures that match the NttManager interface
      async transfer(
        amount: any,
        recipientChain: any,
        recipient: any,
        refundAddress?: any,
        shouldQueue?: any,
        transceiverInstructions?: any
      ) {
        // Simulate the transfer function that returns a uint64 sequence
        return 123
      },
      async quoteDeliveryPrice(
        recipientChain: any,
        transceiverInstructions?: any
      ) {
        // Simulate the quoteDeliveryPrice function that returns (uint256[], uint256)
        return [[], BigNumber.from(50000)]
      },
    } as any

    // Add mock methods to the functions
    nttManager.transfer.returns = (value: any) => {}
    nttManager.transfer.reset = () => {}
    nttManager.quoteDeliveryPrice.returns = (value: any) => {}
    nttManager.quoteDeliveryPrice.reset = () => {}

    // Add call method to simulate contract calls
    nttManager.transfer.call = async function (
      amount: any,
      recipientChain: any,
      recipient: any,
      refundAddress?: any,
      shouldQueue?: any,
      transceiverInstructions?: any
    ) {
      return 123
    }
    nttManager.quoteDeliveryPrice.call = async function (
      recipientChain: any,
      transceiverInstructions?: any
    ) {
      return [[], BigNumber.from(50000)]
    }
    const reimbursementPool = await smock.fake<ReimbursementPool>(
      "ReimbursementPool"
    )

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

    await l1BtcDepositorNtt
      .connect(deployer)
      .transferOwnership(governance.address)

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

  describe("initialization", () => {
    it("should initialize with correct parameters", async () => {
      expect(await l1BtcDepositorNtt.bridge()).to.equal(bridge.address)
      expect(await l1BtcDepositorNtt.tbtcVault()).to.equal(tbtcVault.address)
      expect(await l1BtcDepositorNtt.nttManager()).to.equal(nttManager.address)
      expect(await l1BtcDepositorNtt.owner()).to.equal(governance.address)
    })

    it("should initialize with defaultSupportedChain as 0", async () => {
      expect(await l1BtcDepositorNtt.defaultSupportedChain()).to.equal(0)
    })
  })

  describe("defaultSupportedChain management", () => {
    context("when the caller is not the owner", () => {
      it("should revert when setting default supported chain", async () => {
        await expect(
          l1BtcDepositorNtt
            .connect(relayer)
            .setDefaultSupportedChain(WORMHOLE_CHAIN_SEI)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      context("when setting chain ID to zero", () => {
        it("should revert", async () => {
          await expect(
            l1BtcDepositorNtt.connect(governance).setDefaultSupportedChain(0)
          ).to.be.revertedWith("Chain ID cannot be zero")
        })
      })

      context("when setting unsupported chain as default", () => {
        it("should revert", async () => {
          await expect(
            l1BtcDepositorNtt
              .connect(governance)
              .setDefaultSupportedChain(WORMHOLE_CHAIN_SEI)
          ).to.be.revertedWith(
            "Chain must be supported before setting as default"
          )
        })
      })

      context("when setting supported chain as default", () => {
        before(async () => {
          await createSnapshot()
          await l1BtcDepositorNtt
            .connect(governance)
            .setSupportedChain(WORMHOLE_CHAIN_SEI, true)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should set the default supported chain successfully", async () => {
          const tx = await l1BtcDepositorNtt
            .connect(governance)
            .setDefaultSupportedChain(WORMHOLE_CHAIN_SEI)

          expect(await l1BtcDepositorNtt.defaultSupportedChain()).to.equal(
            WORMHOLE_CHAIN_SEI
          )

          await expect(tx)
            .to.emit(l1BtcDepositorNtt, "DefaultSupportedChainUpdated")
            .withArgs(WORMHOLE_CHAIN_SEI)
        })

        it("should allow changing default chain to another supported chain", async () => {
          // First set SEI as default
          await l1BtcDepositorNtt
            .connect(governance)
            .setDefaultSupportedChain(WORMHOLE_CHAIN_SEI)

          // Add BASE as supported
          await l1BtcDepositorNtt
            .connect(governance)
            .setSupportedChain(WORMHOLE_CHAIN_BASE, true)

          // Change default to BASE
          const tx = await l1BtcDepositorNtt
            .connect(governance)
            .setDefaultSupportedChain(WORMHOLE_CHAIN_BASE)

          expect(await l1BtcDepositorNtt.defaultSupportedChain()).to.equal(
            WORMHOLE_CHAIN_BASE
          )

          await expect(tx)
            .to.emit(l1BtcDepositorNtt, "DefaultSupportedChainUpdated")
            .withArgs(WORMHOLE_CHAIN_BASE)
        })
      })
    })
  })

  describe("AbstractL1BTCDepositor core functions", () => {
    describe("initializeDeposit", () => {
      context("when the L2 deposit owner is zero", () => {
        it("should revert", async () => {
          await expect(
            l1BtcDepositorNtt
              .connect(relayer)
              .initializeDeposit(
                initializeDepositFixture.fundingTx,
                initializeDepositFixture.reveal,
                ethers.constants.HashZero
              )
          ).to.be.revertedWith("L2 deposit owner must not be 0x0")
        })
      })

      context("when the L2 deposit owner is non-zero", () => {
        context("when the requested vault is not TBTCVault", () => {
          it("should revert", async () => {
            const corruptedReveal = JSON.parse(
              JSON.stringify(initializeDepositFixture.reveal)
            )
            corruptedReveal.vault = ethers.constants.AddressZero

            await expect(
              l1BtcDepositorNtt
                .connect(relayer)
                .initializeDeposit(
                  initializeDepositFixture.fundingTx,
                  corruptedReveal,
                  initializeDepositFixture.destinationChainDepositOwner
                )
            ).to.be.revertedWith("Vault address mismatch")
          })
        })

        context("when the requested vault is TBTCVault", () => {
          context("when the deposit state is wrong", () => {
            context("when the deposit state is Initialized", () => {
              before(async () => {
                await createSnapshot()

                await l1BtcDepositorNtt
                  .connect(relayer)
                  .initializeDeposit(
                    initializeDepositFixture.fundingTx,
                    initializeDepositFixture.reveal,
                    initializeDepositFixture.destinationChainDepositOwner
                  )
              })

              after(async () => {
                bridge.revealDepositWithExtraData.reset()
                await restoreSnapshot()
              })

              it("should revert", async () => {
                await expect(
                  l1BtcDepositorNtt
                    .connect(relayer)
                    .initializeDeposit(
                      initializeDepositFixture.fundingTx,
                      initializeDepositFixture.reveal,
                      initializeDepositFixture.destinationChainDepositOwner
                    )
                ).to.be.revertedWith("Wrong deposit state")
              })
            })
          })

          context("when the deposit state is correct", () => {
            before(async () => {
              await createSnapshot()
              bridge.revealDepositWithExtraData.returns(
                initializeDepositFixture.depositKey
              )
            })

            after(async () => {
              bridge.revealDepositWithExtraData.reset()
              await restoreSnapshot()
            })

            it("should initialize deposit successfully", async () => {
              const tx = await l1BtcDepositorNtt
                .connect(relayer)
                .initializeDeposit(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  initializeDepositFixture.destinationChainDepositOwner
                )

              await expect(tx)
                .to.emit(l1BtcDepositorNtt, "DepositInitialized")
                .withArgs(
                  initializeDepositFixture.depositKey,
                  initializeDepositFixture.destinationChainDepositOwner.toLowerCase(),
                  relayer.address
                )

              expect(
                await l1BtcDepositorNtt.deposits(
                  initializeDepositFixture.depositKey
                )
              ).to.equal(1)
            })
          })
        })
      })
    })

    describe("finalizeDeposit", () => {
      context("when the deposit state is wrong", () => {
        context("when the deposit state is Unknown", () => {
          it("should revert", async () => {
            await expect(
              l1BtcDepositorNtt
                .connect(relayer)
                .finalizeDeposit(initializeDepositFixture.depositKey)
            ).to.be.revertedWith("Wrong deposit state")
          })
        })
      })

      context("when the deposit state is correct", () => {
        before(async () => {
          await createSnapshot()

          await l1BtcDepositorNtt
            .connect(relayer)
            .initializeDeposit(
              initializeDepositFixture.fundingTx,
              initializeDepositFixture.reveal,
              initializeDepositFixture.destinationChainDepositOwner
            )

          const revealedAt = (await lastBlockTime()) - 7200
          const finalizedAt = await lastBlockTime()
          bridge.deposits
            .whenCalledWith(initializeDepositFixture.depositKey)
            .returns({
              depositor: ethers.constants.AddressZero,
              amount: BigNumber.from(100000),
              revealedAt,
              vault: ethers.constants.AddressZero,
              treasuryFee: BigNumber.from(0),
              sweptAt: finalizedAt,
              extraData: ethers.constants.HashZero,
            })

          tbtcVault.optimisticMintingRequests
            .whenCalledWith(initializeDepositFixture.depositKey)
            .returns([revealedAt, finalizedAt])

          nttManager.quoteDeliveryPrice.returns([[], BigNumber.from(50000)])
          nttManager.transfer.returns(123)

          await l1BtcDepositorNtt
            .connect(governance)
            .setSupportedChain(WORMHOLE_CHAIN_SEI, true)

          await tbtcToken.mint(
            l1BtcDepositorNtt.address,
            ethers.utils.parseEther("1").mul(10)
          )
        })

        after(async () => {
          bridge.revealDepositWithExtraData.reset()
          bridge.deposits.reset()
          tbtcVault.optimisticMintingRequests.reset()
          nttManager.quoteDeliveryPrice.reset()
          nttManager.transfer.reset()
          await restoreSnapshot()
        })
      })
    })

    describe("updateGasOffsetParameters", () => {
      context("when the caller is not the owner", () => {
        it("should revert", async () => {
          await expect(
            l1BtcDepositorNtt
              .connect(relayer)
              .updateGasOffsetParameters(1000, 2000)
          ).to.be.revertedWith("Ownable: caller is not the owner")
        })
      })

      context("when the caller is the owner", () => {
        before(async () => {
          await createSnapshot()
          await l1BtcDepositorNtt
            .connect(governance)
            .updateGasOffsetParameters(1000, 2000)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should set the gas offset params properly", async () => {
          expect(
            await l1BtcDepositorNtt.initializeDepositGasOffset()
          ).to.be.equal(1000)
          expect(
            await l1BtcDepositorNtt.finalizeDepositGasOffset()
          ).to.be.equal(2000)
        })

        it("should emit GasOffsetParametersUpdated event", async () => {
          await expect(
            l1BtcDepositorNtt
              .connect(governance)
              .updateGasOffsetParameters(1000, 2000)
          )
            .to.emit(l1BtcDepositorNtt, "GasOffsetParametersUpdated")
            .withArgs(1000, 2000)
        })
      })
    })

    describe("updateReimbursementAuthorization", () => {
      context("when the caller is not the owner", () => {
        it("should revert", async () => {
          await expect(
            l1BtcDepositorNtt
              .connect(relayer)
              .updateReimbursementAuthorization(relayer.address, true)
          ).to.be.revertedWith("Ownable: caller is not the owner")
        })
      })

      context("when the caller is the owner", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()
          tx = await l1BtcDepositorNtt
            .connect(governance)
            .updateReimbursementAuthorization(relayer.address, true)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should set the authorization properly", async () => {
          expect(
            await l1BtcDepositorNtt.reimbursementAuthorizations(relayer.address)
          ).to.be.true
        })

        it("should emit ReimbursementAuthorizationUpdated event", async () => {
          await expect(tx)
            .to.emit(l1BtcDepositorNtt, "ReimbursementAuthorizationUpdated")
            .withArgs(relayer.address, true)
        })
      })
    })

    describe("setReimburseTxMaxFee", () => {
      context("when the caller is not the owner", () => {
        it("should revert", async () => {
          await expect(
            l1BtcDepositorNtt.connect(relayer).setReimburseTxMaxFee(true)
          ).to.be.revertedWith("Ownable: caller is not the owner")
        })
      })

      context("when the caller is the owner", () => {
        it("should enable transaction max fee reimbursement", async () => {
          const tx = await l1BtcDepositorNtt
            .connect(governance)
            .setReimburseTxMaxFee(true)

          await expect(tx)
            .to.emit(l1BtcDepositorNtt, "ReimburseTxMaxFeeUpdated")
            .withArgs(true)

          expect(await l1BtcDepositorNtt.reimburseTxMaxFee()).to.be.true
        })

        it("should disable transaction max fee reimbursement", async () => {
          await l1BtcDepositorNtt.connect(governance).setReimburseTxMaxFee(true)

          const tx = await l1BtcDepositorNtt
            .connect(governance)
            .setReimburseTxMaxFee(false)

          await expect(tx)
            .to.emit(l1BtcDepositorNtt, "ReimburseTxMaxFeeUpdated")
            .withArgs(false)

          expect(await l1BtcDepositorNtt.reimburseTxMaxFee()).to.be.false
        })
      })
    })
  })
})

// Just an arbitrary TBTCVault address.
const tbtcVaultAddress = "0xB5679dE944A79732A75CE556191DF11F489448d5"

export type InitializeDepositFixture = {
  depositKey: string
  fundingTx: BitcoinTxInfoStruct
  reveal: DepositRevealInfoStruct
  destinationChainDepositOwner: string
}

export const initializeDepositFixture: InitializeDepositFixture = {
  depositKey:
    "0x97a4104f4114ba56dde79d02c4e8296596c3259da60d0e53fa97170f7cf7258d",
  fundingTx: {
    version: "0x01000000",
    inputVector:
      "0x01dfe39760a5edabdab013114053d789ada21e356b59fea41d980396" +
      "c1a4474fad0100000023220020e57edf10136b0434e46bc08c5ac5a1e4" +
      "5f64f778a96f984d0051873c7a8240f2ffffffff",
    outputVector:
      "0x02804f1200000000002200202f601522e7bb1f7de5c56bdbd45590b3" +
      "499bad09190581dcaa17e152d8f0c2a9b7e837000000000017a9148688" +
      "4e6be1525dab5ae0b451bd2c72cee67dcf4187",
    locktime: "0x00000000",
  },
  reveal: {
    fundingOutputIndex: 0,
    blindingFactor: "0xba863847d2d0fee3",
    walletPubKeyHash: "0xf997563fee8610ca28f99ac05bd8a29506800d4d",
    refundPubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
    refundLocktime: "0xde2b4c67",
    vault: tbtcVaultAddress,
  },
  destinationChainDepositOwner: toWormholeAddress(
    "0x23b82a7108F9CEb34C3CDC44268be21D151d4124"
  ),
}

function toWormholeAddress(address: string): string {
  return `0x000000000000000000000000${address.slice(2)}`
}
