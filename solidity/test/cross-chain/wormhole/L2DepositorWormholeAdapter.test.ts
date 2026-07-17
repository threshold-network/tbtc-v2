import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { randomBytes } from "crypto"
import chai, { expect } from "chai"
import { FakeContract, smock } from "@defi-wonderland/smock"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { ContractTransaction } from "ethers"
import {
  IWormholeGateway,
  IWormholeRelayer,
  L2BTCDepositorWormhole,
} from "../../../typechain"
import {
  initializeDepositFixture,
  toWormholeAddress,
} from "./L1BTCDepositorWormhole.test"

chai.use(smock.matchers)

const { impersonateAccount } = helpers.account
const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("L2BTCDepositorWormhole", () => {
  const contractsFixture = async () => {
    const { deployer, governance } = await helpers.signers.getNamedSigners()

    const accounts = await getUnnamedAccounts()
    const relayer = await ethers.getSigner(accounts[1])

    const wormholeRelayer = await smock.fake<IWormholeRelayer>(
      "IWormholeRelayer"
    )
    const l2WormholeGateway = await smock.fake<IWormholeGateway>(
      "IWormholeGateway"
    )
    // Just an arbitrary chain ID.
    const l1ChainId = 2
    // Just an arbitrary L1BTCDepositorWormhole address.
    const l1BtcDepositor = "0xeE6F5f69860f310114185677D017576aed0dEC83"

    const deployment = await helpers.upgrades.deployProxy(
      // Hacky workaround allowing to deploy proxy contract any number of times
      // without clearing `deployments/hardhat` directory.
      // See: https://github.com/keep-network/hardhat-helpers/issues/38
      `L2BTCDepositorWormhole_${randomBytes(8).toString("hex")}`,
      {
        contractName: "L2BTCDepositorWormhole",
        initializerArgs: [
          wormholeRelayer.address,
          l2WormholeGateway.address,
          l1ChainId,
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: {
          kind: "transparent",
        },
      }
    )
    const l2BtcDepositor = deployment[0] as L2BTCDepositorWormhole

    await l2BtcDepositor.connect(deployer).transferOwnership(governance.address)

    return {
      governance,
      relayer,
      wormholeRelayer,
      l2WormholeGateway,
      l1BtcDepositor,
      l2BtcDepositor,
    }
  }

  let governance: SignerWithAddress
  let relayer: SignerWithAddress

  let wormholeRelayer: FakeContract<IWormholeRelayer>
  let l2WormholeGateway: FakeContract<IWormholeGateway>
  let l1BtcDepositor: string
  let l2BtcDepositor: L2BTCDepositorWormhole

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      governance,
      relayer,
      wormholeRelayer,
      l2WormholeGateway,
      l1BtcDepositor,
      l2BtcDepositor,
    } = await waffle.loadFixture(contractsFixture))
  })

  describe("attachL1BtcDepositor", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          l2BtcDepositor.connect(relayer).attachL1BtcDepositor(l1BtcDepositor)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      context("when the L1BTCcoinDepositor is already attached", () => {
        before(async () => {
          await createSnapshot()

          await l2BtcDepositor
            .connect(governance)
            .attachL1BtcDepositor(l1BtcDepositor)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            l2BtcDepositor
              .connect(governance)
              .attachL1BtcDepositor(l1BtcDepositor)
          ).to.be.revertedWith("L1 Bitcoin Depositor already set")
        })
      })

      context("when the L1BTCDepositorWormhole is not attached", () => {
        context("when new L1BTCDepositorWormhole is zero", () => {
          it("should revert", async () => {
            await expect(
              l2BtcDepositor
                .connect(governance)
                .attachL1BtcDepositor(ethers.constants.AddressZero)
            ).to.be.revertedWith("L1 Bitcoin Depositor must not be 0x0")
          })
        })

        context("when new L1BTCDepositorWormhole is non-zero", () => {
          before(async () => {
            await createSnapshot()

            await l2BtcDepositor
              .connect(governance)
              .attachL1BtcDepositor(l1BtcDepositor)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should set the l1BtcDepositor address properly", async () => {
            expect(await l2BtcDepositor.l1BtcDepositor()).to.equal(
              l1BtcDepositor
            )
          })
        })
      })
    })
  })

  describe("initializeDeposit", () => {
    let tx: ContractTransaction

    before(async () => {
      await createSnapshot()

      tx = await l2BtcDepositor
        .connect(relayer)
        .initializeDeposit(
          initializeDepositFixture.fundingTx,
          initializeDepositFixture.reveal,
          ethers.utils.hexDataSlice(
            initializeDepositFixture.destinationChainDepositOwner,
            12
          )
        )
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should emit DepositInitialized event", async () => {
      const { fundingTx, reveal, destinationChainDepositOwner } =
        initializeDepositFixture
      const l2DepositOwnerInEthereumAddress = ethers.utils.hexDataSlice(
        destinationChainDepositOwner,
        12
      )

      // The `expect.to.emit.withArgs` assertion has troubles with
      // matching complex event arguments as it uses strict equality
      // underneath. To overcome that problem, we manually get event's
      // arguments and check it against the expected ones using deep
      // equality assertion (eql).
      const receipt = await ethers.provider.getTransactionReceipt(tx.hash)
      expect(receipt.logs.length).to.be.equal(1)
      expect(l2BtcDepositor.interface.parseLog(receipt.logs[0]).args).to.be.eql(
        [
          [
            fundingTx.version,
            fundingTx.inputVector,
            fundingTx.outputVector,
            fundingTx.locktime,
          ],
          [
            reveal.fundingOutputIndex,
            reveal.blindingFactor,
            reveal.walletPubKeyHash,
            reveal.refundPubKeyHash,
            reveal.refundLocktime,
            reveal.vault,
          ],
          l2DepositOwnerInEthereumAddress,
          relayer.address,
        ]
      )
    })
  })

  describe("receiveWormholeMessages", () => {
    before(async () => {
      await createSnapshot()

      await l2BtcDepositor
        .connect(governance)
        .attachL1BtcDepositor(l1BtcDepositor)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the caller is not the WormholeRelayer", () => {
      it("should revert", async () => {
        await expect(
          l2BtcDepositor
            .connect(relayer)
            // Parameters don't matter as the call should revert before.
            .receiveWormholeMessages(
              ethers.constants.HashZero,
              [],
              ethers.constants.HashZero,
              0,
              ethers.constants.HashZero
            )
        ).to.be.revertedWith("Caller is not Wormhole Relayer")
      })
    })

    context("when the caller is the WormholeRelayer", () => {
      let wormholeRelayerSigner: SignerWithAddress

      before(async () => {
        await createSnapshot()

        wormholeRelayerSigner = await impersonateAccount(
          wormholeRelayer.address,
          {
            from: governance,
            value: 10,
          }
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when the source chain is not the expected L1", () => {
        it("should revert", async () => {
          await expect(
            l2BtcDepositor
              .connect(wormholeRelayerSigner)
              .receiveWormholeMessages(
                ethers.constants.HashZero,
                [],
                ethers.constants.HashZero,
                0,
                ethers.constants.HashZero
              )
          ).to.be.revertedWith("Source chain is not the expected L1 chain")
        })
      })

      context("when the source chain is the expected L1", () => {
        context(
          "when the source address is not the L1BTCDepositorWormhole",
          () => {
            it("should revert", async () => {
              await expect(
                l2BtcDepositor
                  .connect(wormholeRelayerSigner)
                  .receiveWormholeMessages(
                    ethers.constants.HashZero,
                    [],
                    toWormholeAddress(relayer.address),
                    await l2BtcDepositor.l1ChainId(),
                    ethers.constants.HashZero
                  )
              ).to.be.revertedWith(
                "Source address is not the expected L1 Bitcoin depositor"
              )
            })
          }
        )

        context("when the source address is the L1BTCDepositorWormhole", () => {
          context("when the number of additional VAAs is not 1", () => {
            it("should revert", async () => {
              await expect(
                l2BtcDepositor
                  .connect(wormholeRelayerSigner)
                  .receiveWormholeMessages(
                    ethers.constants.HashZero,
                    [],
                    toWormholeAddress(l1BtcDepositor),
                    await l2BtcDepositor.l1ChainId(),
                    ethers.constants.HashZero
                  )
              ).to.be.revertedWith(
                "Expected 1 additional VAA key for token transfer"
              )
            })
          })

          context("when the number of additional VAAs is 1", () => {
            before(async () => {
              await createSnapshot()

              l2WormholeGateway.receiveTbtc.returns()

              await l2BtcDepositor
                .connect(wormholeRelayerSigner)
                .receiveWormholeMessages(
                  ethers.constants.HashZero,
                  ["0x1234"],
                  toWormholeAddress(l1BtcDepositor),
                  await l2BtcDepositor.l1ChainId(),
                  ethers.constants.HashZero
                )
            })

            after(async () => {
              l2WormholeGateway.receiveTbtc.reset()

              await restoreSnapshot()
            })

            it("should pass the VAA to the L2WormholeGateway", async () => {
              expect(l2WormholeGateway.receiveTbtc).to.have.been.calledOnceWith(
                "0x1234"
              )
            })
          })
        })
      })
    })
  })
})
