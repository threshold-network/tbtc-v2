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

// Wormhole chain IDs
const WORMHOLE_CHAIN_ETH = 2
const WORMHOLE_CHAIN_SEI = 26
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

describe("L1BTCDepositorNtt NTT Integration", () => {
  let governance: SignerWithAddress
  let relayer: SignerWithAddress
  let user: SignerWithAddress
  let bridge: FakeContract<IBridge>
  let tbtcToken: TestERC20
  let tbtcVault: FakeContract<ITBTCVault>
  let nttManager: any
  let reimbursementPool: FakeContract<ReimbursementPool>
  let l1BtcDepositorNtt: L1BTCDepositorNtt

  const contractsFixture = async () => {
    const { deployer, governance: gov } =
      await helpers.signers.getNamedSigners()

    const accounts = await getUnnamedAccounts()
    const relayer = await ethers.getSigner(accounts[1])
    const user = await ethers.getSigner(accounts[2])

    // Mock contracts
    bridge = await smock.fake<IBridge>("IBridge")
    tbtcVault = await smock.fake<ITBTCVault>("ITBTCVault")
    reimbursementPool = await smock.fake<ReimbursementPool>("ReimbursementPool")

    // Create manual mock for NTT Manager
    nttManager = {
      address: ethers.Wallet.createRandom().address,
      async transfer(
        amount: any,
        recipientChain: any,
        recipient: any,
        refundAddress?: any,
        shouldQueue?: any,
        transceiverInstructions?: any
      ) {
        return 123
      },
      async quoteDeliveryPrice(
        recipientChain: any,
        transceiverInstructions?: any
      ) {
        return [[], BigNumber.from(50000)]
      },
    } as any
    // Add mock methods to the functions
    nttManager.transfer.returns = (value: any) => {}
    nttManager.transfer.reset = () => {}
    nttManager.quoteDeliveryPrice.returns = (value: any) => {}
    nttManager.quoteDeliveryPrice.reset = () => {}

    // Deploy tBTC token
    const tbtcToken = await (
      await ethers.getContractFactory("TestERC20")
    ).deploy()

    // Deploy L1BTCDepositorNtt
    const deployment = await helpers.upgrades.deployProxy(
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
    await l1BtcDepositorNtt.connect(deployer).transferOwnership(gov.address)

    return {
      governance: gov,
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

  before(async () => {
    const fixture = await waffle.loadFixture(contractsFixture)
    governance = fixture.governance
    relayer = fixture.relayer
    user = fixture.user
    bridge = fixture.bridge
    tbtcToken = fixture.tbtcToken
    tbtcVault = fixture.tbtcVault
    nttManager = fixture.nttManager
    reimbursementPool = fixture.reimbursementPool
    l1BtcDepositorNtt = fixture.l1BtcDepositorNtt
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  describe("NTT integration", () => {
    describe("setSupportedChain", () => {
      context("when caller is not owner", () => {
        it("should revert", async () => {
          await expect(
            l1BtcDepositorNtt
              .connect(relayer)
              .setSupportedChain(WORMHOLE_CHAIN_SEI, true)
          ).to.be.revertedWith("Ownable: caller is not the owner")
        })
      })

      context("when caller is owner", () => {
        it("should set supported chain", async () => {
          await l1BtcDepositorNtt
            .connect(governance)
            .setSupportedChain(WORMHOLE_CHAIN_SEI, true)

          expect(await l1BtcDepositorNtt.supportedChains(WORMHOLE_CHAIN_SEI)).to
            .be.true
        })

        it("should remove supported chain", async () => {
          await l1BtcDepositorNtt
            .connect(governance)
            .setSupportedChain(WORMHOLE_CHAIN_SEI, false)

          expect(await l1BtcDepositorNtt.supportedChains(WORMHOLE_CHAIN_SEI)).to
            .be.false
        })
      })
    })

    describe("supported chains management", () => {
      it("should handle maximum chain ID (65535)", async () => {
        const maxChainId = 65535
        await l1BtcDepositorNtt
          .connect(governance)
          .setSupportedChain(maxChainId, true)

        expect(await l1BtcDepositorNtt.supportedChains(maxChainId)).to.be.true
      })

      it("should handle chain ID 1", async () => {
        const minChainId = 1
        await l1BtcDepositorNtt
          .connect(governance)
          .setSupportedChain(minChainId, true)

        expect(await l1BtcDepositorNtt.supportedChains(minChainId)).to.be.true
      })
    })

    describe("default supported chain management", () => {
      context("when caller is not owner", () => {
        it("should revert when setting default supported chain", async () => {
          await expect(
            l1BtcDepositorNtt
              .connect(relayer)
              .setDefaultSupportedChain(WORMHOLE_CHAIN_SEI)
          ).to.be.revertedWith("Ownable: caller is not the owner")
        })
      })

      context("when caller is owner", () => {
        before(async () => {
          await l1BtcDepositorNtt
            .connect(governance)
            .setSupportedChain(WORMHOLE_CHAIN_SEI, true)
        })

        it("should set default supported chain successfully", async () => {
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

        it("should revert when setting unsupported chain as default", async () => {
          await expect(
            l1BtcDepositorNtt
              .connect(governance)
              .setDefaultSupportedChain(WORMHOLE_CHAIN_BASE)
          ).to.be.revertedWith(
            "Chain must be supported before setting as default"
          )
        })

        it("should revert when setting zero chain ID as default", async () => {
          await expect(
            l1BtcDepositorNtt.connect(governance).setDefaultSupportedChain(0)
          ).to.be.revertedWith("Chain ID cannot be zero")
        })
      })
    })

    describe("NTT Manager management", () => {
      describe("getNttConfiguration", () => {
        it("should return current NTT Manager address", async () => {
          const config = await l1BtcDepositorNtt.getNttConfiguration()
          expect(config).to.equal(nttManager.address)
        })
      })

      describe("updateNttManager", () => {
        context("when caller is not owner", () => {
          it("should revert", async () => {
            await expect(
              l1BtcDepositorNtt
                .connect(relayer)
                .updateNttManager(nttManager.address)
            ).to.be.revertedWith("Ownable: caller is not the owner")
          })
        })

        context("when caller is owner", () => {
          context("when new NTT Manager is zero address", () => {
            it("should revert", async () => {
              await expect(
                l1BtcDepositorNtt
                  .connect(governance)
                  .updateNttManager(ethers.constants.AddressZero)
              ).to.be.revertedWith("NTT Manager address cannot be zero")
            })
          })

          context("when new NTT Manager is valid", () => {
            let newNttManager: any
            let tx: ContractTransaction

            before(async () => {
              newNttManager = {
                address: ethers.Wallet.createRandom().address,
                async transfer() {
                  return 123
                },
                async quoteDeliveryPrice() {
                  return [[], BigNumber.from(50000)]
                },
              } as any
              newNttManager.transfer.returns = () => {}
              newNttManager.transfer.reset = () => {}
              newNttManager.quoteDeliveryPrice.returns = () => {}
              newNttManager.quoteDeliveryPrice.reset = () => {}

              tx = await l1BtcDepositorNtt
                .connect(governance)
                .updateNttManager(newNttManager.address)
            })

            it("should update the NTT Manager address", async () => {
              expect(await l1BtcDepositorNtt.getNttConfiguration()).to.equal(
                newNttManager.address
              )
            })

            it("should emit NttManagerUpdated event", async () => {
              await expect(tx)
                .to.emit(l1BtcDepositorNtt, "NttManagerUpdated")
                .withArgs(nttManager.address, newNttManager.address)
            })
          })
        })
      })
    })
  })
})
