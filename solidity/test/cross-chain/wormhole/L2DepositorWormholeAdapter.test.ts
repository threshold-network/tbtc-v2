import { ethers, getUnnamedAccounts, helpers } from "hardhat"
import { randomBytes } from "crypto"
import { expect } from "chai"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { ContractTransactionResponse } from "ethers"
import { requireValue } from "../../../helpers/require-value"
import { loadFixture } from "../../helpers/fixture"
import {
  IWormholeGateway,
  IWormholeRelayer,
  L2BTCDepositorWormhole,
} from "../../../typechain"
import {
  initializeDepositFixture,
  toWormholeAddress,
} from "./L1BTCDepositorWormhole.test"
import { createMock, expectCalledOnceWith } from "../../helpers/mock"
import type { Mock } from "../../helpers/mock"

const { impersonateAccount } = helpers.account
const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("L2BTCDepositorWormhole", () => {
  const contractsFixture = async () => {
    const { deployer, governance } = await helpers.signers.getNamedSigners()

    const accounts = await getUnnamedAccounts()
    const relayer = await ethers.getSigner(accounts[1])

    const wormholeRelayer = await createMock<IWormholeRelayer>(
      "IWormholeRelayer"
    )
    const l2WormholeGateway = await createMock<IWormholeGateway>(
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
    const l2BtcDepositor = deployment[0] as unknown as L2BTCDepositorWormhole

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

  let governance: HardhatEthersSigner
  let relayer: HardhatEthersSigner

  let wormholeRelayer: Mock<IWormholeRelayer>
  let l2WormholeGateway: Mock<IWormholeGateway>
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
    } = await loadFixture(contractsFixture))
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
                .attachL1BtcDepositor(ethers.ZeroAddress)
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
    let tx: ContractTransactionResponse

    before(async () => {
      await createSnapshot()

      tx = await l2BtcDepositor
        .connect(relayer)
        .initializeDeposit(
          initializeDepositFixture.fundingTx,
          initializeDepositFixture.reveal,
          ethers.dataSlice(
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
      const l2DepositOwnerInEthereumAddress = ethers.dataSlice(
        destinationChainDepositOwner,
        12
      )

      // The `expect.to.emit.withArgs` assertion has troubles with
      // matching complex event arguments as it uses strict equality
      // underneath. To overcome that problem, we manually get event's
      // arguments and check it against the expected ones using deep
      // equality assertion (eql).
      const receipt = requireValue(
        await ethers.provider.getTransactionReceipt(tx.hash),
        "Transaction receipt"
      )
      expect(receipt.logs.length).to.be.equal(1)
      expect(
        requireValue(
          l2BtcDepositor.interface.parseLog(receipt.logs[0]),
          "ABI fragment"
        ).args
      ).to.be.eql([
        [
          fundingTx.version,
          fundingTx.inputVector,
          fundingTx.outputVector,
          fundingTx.locktime,
        ],
        [
          ethers.toBigInt(reveal.fundingOutputIndex),
          reveal.blindingFactor,
          reveal.walletPubKeyHash,
          reveal.refundPubKeyHash,
          reveal.refundLocktime,
          reveal.vault,
        ],
        ethers.getAddress(l2DepositOwnerInEthereumAddress),
        relayer.address,
      ])
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
              ethers.ZeroHash,
              [],
              ethers.ZeroHash,
              0,
              ethers.ZeroHash
            )
        ).to.be.revertedWith("Caller is not Wormhole Relayer")
      })
    })

    context("when the caller is the WormholeRelayer", () => {
      let wormholeRelayerSigner: HardhatEthersSigner

      before(async () => {
        await createSnapshot()

        wormholeRelayerSigner = await impersonateAccount(
          wormholeRelayer.address,
          {
            from: governance,
            value: 10n,
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
                ethers.ZeroHash,
                [],
                ethers.ZeroHash,
                0,
                ethers.ZeroHash
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
                    ethers.ZeroHash,
                    [],
                    toWormholeAddress(relayer.address),
                    await l2BtcDepositor.l1ChainId(),
                    ethers.ZeroHash
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
                    ethers.ZeroHash,
                    [],
                    toWormholeAddress(l1BtcDepositor),
                    await l2BtcDepositor.l1ChainId(),
                    ethers.ZeroHash
                  )
              ).to.be.revertedWith(
                "Expected 1 additional VAA key for token transfer"
              )
            })
          })

          context("when the number of additional VAAs is 1", () => {
            before(async () => {
              await createSnapshot()

              await l2WormholeGateway.receiveTbtc.returns()

              await l2BtcDepositor
                .connect(wormholeRelayerSigner)
                .receiveWormholeMessages(
                  ethers.ZeroHash,
                  ["0x1234"],
                  toWormholeAddress(l1BtcDepositor),
                  await l2BtcDepositor.l1ChainId(),
                  ethers.ZeroHash
                )
            })

            after(async () => {
              await l2WormholeGateway.receiveTbtc.reset()

              await restoreSnapshot()
            })

            it("should pass the VAA to the L2WormholeGateway", async () => {
              await expectCalledOnceWith(l2WormholeGateway.receiveTbtc, [
                "0x1234",
              ])
            })
          })
        })
      })
    })
  })
})
