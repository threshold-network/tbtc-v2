import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"

import { randomBytes } from "crypto"
import { expect } from "chai"
import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { ContractTransaction } from "ethers"
import { to1e18 } from "../helpers/contract-test-helpers"

import type {
  L2TBTC,
  WormholeBridgeStub,
  TestERC20,
  L2WormholeGateway,
} from "../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

const ZERO_ADDRESS = ethers.constants.AddressZero

describe("L2WormholeGateway", () => {
  const fixture = async () => {
    const { deployer, governance } = await helpers.signers.getNamedSigners()

    //
    // Deploy L2 canonical tBTC token.
    //
    let deployment = await helpers.upgrades.deployProxy(
      // Hacky workaround allowing to deploy proxy contract any number of times
      // without clearing `deployments/hardhat` directory.
      // See: https://github.com/keep-network/hardhat-helpers/issues/38
      `L2TBTC_${randomBytes(8).toString("hex")}`,
      {
        contractName: "L2TBTC",
        initializerArgs: ["Arbitrum TBTC", "ArbTBTC"],
        factoryOpts: { signer: deployer },
        proxyOpts: {
          kind: "transparent",
        },
      }
    )
    const canonicalTbtc = deployment[0] as L2TBTC

    //
    // Deploy test token as the Wormhole Bridge L2 tBTC representation.
    //
    const TestERC20 = await ethers.getContractFactory("TestERC20")
    const wormholeTbtc = await TestERC20.deploy()
    await wormholeTbtc.deployed()

    //
    // Deploy stub of the Wormhole Bridge contract.
    // Stub contract is used instead of a smock because of the token transfer
    // that needs to happen in completeTransferWithPayload function.
    //
    const WormholeBridgeStub = await ethers.getContractFactory(
      "WormholeBridgeStub"
    )
    const wormholeBridgeStub = await WormholeBridgeStub.deploy(
      wormholeTbtc.address
    )
    await wormholeBridgeStub.deployed()

    //
    // Deploy the L2WormholeGateway.
    //
    deployment = await helpers.upgrades.deployProxy(
      // Hacky workaround allowing to deploy proxy contract any number of times
      // without clearing `deployments/hardhat` directory.
      // See: https://github.com/keep-network/hardhat-helpers/issues/38
      `L2WormholeGateway_${randomBytes(8).toString("hex")}`,
      {
        contractName: "L2WormholeGateway",
        initializerArgs: [
          wormholeBridgeStub.address,
          wormholeTbtc.address,
          canonicalTbtc.address,
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: {
          kind: "transparent",
        },
      }
    )
    const gateway = deployment[0] as L2WormholeGateway

    //
    // Wire up contracts and transfer ownership.
    //
    await canonicalTbtc.addMinter(gateway.address)
    await wormholeTbtc.transferOwnership(wormholeBridgeStub.address)
    await gateway.transferOwnership(governance.address)

    const accounts = await getUnnamedAccounts()
    const depositor1 = await ethers.getSigner(accounts[1])
    const depositor2 = await ethers.getSigner(accounts[2])

    return {
      governance,
      depositor1,
      depositor2,
      wormholeTbtc,
      canonicalTbtc,
      wormholeBridgeStub,
      gateway,
    }
  }

  // We use IWormholeTokenBridge stub in unit tests so the encodedVM content
  // does not matter. Using an arbitrary array of bytes.
  const encodedVm =
    "0x1230000000000000000000000000000000000000000000000000000000000321"

  let governance: SignerWithAddress
  let depositor1: SignerWithAddress
  let depositor2: SignerWithAddress
  let wormholeTbtc: TestERC20
  let canonicalTbtc: L2TBTC
  let wormholeBridgeStub: WormholeBridgeStub
  let gateway: L2WormholeGateway

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      governance,
      depositor1,
      depositor2,
      wormholeTbtc,
      canonicalTbtc,
      wormholeBridgeStub,
      gateway,
    } = await waffle.loadFixture(fixture))
  })

  // Returns hexString padded on the left with zeros to 32 bytes.
  const padTo32Bytes = (hex: string) => ethers.utils.hexZeroPad(hex, 32)

  describe("initialization", () => {
    it("should set the wormhole bridge address", async () => {
      expect(await gateway.bridge()).to.equal(wormholeBridgeStub.address)
    })

    it("should set the wormhole bridge token address", async () => {
      expect(await gateway.bridgeToken()).to.equal(wormholeTbtc.address)
    })

    it("should set the canonical tBTC address", async () => {
      expect(await gateway.tbtc()).to.equal(canonicalTbtc.address)
    })
  })

  describe("receiveTbtc", () => {
    context("when receiver is the zero address", () => {
      before(async () => {
        await createSnapshot()

        await wormholeBridgeStub.setReceiverAddress(padTo32Bytes(ZERO_ADDRESS))
        await wormholeBridgeStub.setTransferAmount(10)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(gateway.receiveTbtc(encodedVm)).to.be.revertedWith(
          "0x0 receiver not allowed"
        )
      })
    })

    context("when the transferred amount is zero", () => {
      before(async () => {
        await createSnapshot()

        await wormholeBridgeStub.setReceiverAddress(
          padTo32Bytes(depositor1.address)
        )
        await wormholeBridgeStub.setTransferAmount(0)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(gateway.receiveTbtc(encodedVm)).to.be.revertedWith(
          "No tBTC transferred"
        )
      })
    })

    context("when receiver is non-zero address", () => {
      context("when the minting limit was not reached", () => {
        const transferAmount = 13373

        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()
          await wormholeBridgeStub.setReceiverAddress(
            padTo32Bytes(depositor1.address)
          )
          await wormholeBridgeStub.setTransferAmount(transferAmount)

          tx = await gateway.receiveTbtc(encodedVm)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should transfer wormhole tBTC to the contract", async () => {
          expect(await wormholeTbtc.balanceOf(gateway.address)).to.equal(
            transferAmount
          )
        })

        it("should mint tBTC to the receiver", async () => {
          expect(await canonicalTbtc.balanceOf(depositor1.address)).to.equal(
            transferAmount
          )
        })

        it("should complete transfer with the bridge", async () => {
          await expect(tx)
            .to.emit(
              wormholeBridgeStub,
              "WormholeBridgeStub_completeTransferWithPayload"
            )
            .withArgs(encodedVm)
        })

        it("should emit the WormholeTbtcReceived event", async () => {
          await expect(tx)
            .to.emit(gateway, "WormholeTbtcReceived")
            .withArgs(depositor1.address, transferAmount)
        })

        it("should increase the minted amount counter", async () => {
          expect(await gateway.mintedAmount()).to.equal(transferAmount)
        })
      })

      context("when the minting limit was reached", () => {
        before(async () => {
          await createSnapshot()
          await gateway.connect(governance).updateMintingLimit(100)

          await wormholeBridgeStub.setReceiverAddress(
            padTo32Bytes(depositor1.address)
          )
          await wormholeBridgeStub.setTransferAmount(40)
          await gateway.receiveTbtc(encodedVm)

          await wormholeBridgeStub.setReceiverAddress(
            padTo32Bytes(depositor2.address)
          )
          await wormholeBridgeStub.setTransferAmount(40)
          await gateway.receiveTbtc(encodedVm)

          await wormholeBridgeStub.setReceiverAddress(
            padTo32Bytes(depositor1.address)
          )
          await wormholeBridgeStub.setTransferAmount(19)
          await gateway.receiveTbtc(encodedVm)

          await wormholeBridgeStub.setReceiverAddress(
            padTo32Bytes(depositor2.address)
          )
          await wormholeBridgeStub.setTransferAmount(10)
          await gateway.receiveTbtc(encodedVm)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should transfer wormhole tBTC to the contract", async () => {
          // 40 + 40 + 19 + 10 transferred to the contract, the last 10
          // sent to the depositor2 after reaching the minting limit
          expect(await wormholeTbtc.balanceOf(gateway.address)).to.equal(99)
        })

        it("should mint tBTC to the receiver before reaching the minting limit", async () => {
          // 40 + 19, minting limit not exceeded
          expect(await canonicalTbtc.balanceOf(depositor1.address)).to.equal(59)

          // 40, then the minting limit exceeded
          expect(await canonicalTbtc.balanceOf(depositor2.address)).to.equal(40)
        })

        it("should send wormhole tBTC to the receiver after reaching the minting limit", async () => {
          // the last call to receiveTbtc exceeded the minting limit
          expect(await wormholeTbtc.balanceOf(depositor2.address)).to.equal(10)
        })

        it("should increase the minted amount counter", async () => {
          // minted 40 + 40 + 19 canonical tBTC; the last bridge transfer did
          // not lead to minting given the minting limit was reached
          expect(await gateway.mintedAmount()).to.equal(99)
        })
      })
    })
  })

  describe("sendTbtc", () => {
    const recipientChain = 2
    const recipient = padTo32Bytes("0x3e7e00b99c98b79c191b0065d177dacf8821f2a7")
    const arbiterFee = 3
    const nonce = 4

    const liquidity = to1e18(1100)

    before(async () => {
      await createSnapshot()

      await wormholeBridgeStub.setReceiverAddress(
        padTo32Bytes(depositor1.address)
      )
      await wormholeBridgeStub.setTransferAmount(liquidity)

      await gateway.receiveTbtc(encodedVm)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when there is not enough wormhole tBTC", () => {
      it("should revert", async () => {
        await expect(
          gateway
            .connect(depositor1)
            .sendTbtc(
              liquidity.add(to1e18(1)),
              recipientChain,
              padTo32Bytes(recipient),
              arbiterFee,
              nonce
            )
        ).to.be.revertedWith(
          "Not enough wormhole tBTC in the gateway to bridge"
        )
      })
    })

    context("when there is enough wormhole tBTC", () => {
      context("when the receiver address is zero", () => {
        it("should revert", async () => {
          await expect(
            gateway
              .connect(depositor1)
              .sendTbtc(
                liquidity,
                recipientChain,
                padTo32Bytes(ZERO_ADDRESS),
                arbiterFee,
                nonce
              )
          ).to.be.revertedWith("0x0 recipient not allowed")
        })
      })

      context("when the amount is zero", async () => {
        it("should revert", async () => {
          await expect(
            gateway
              .connect(depositor1)
              .sendTbtc(
                0,
                recipientChain,
                padTo32Bytes(recipient),
                arbiterFee,
                nonce
              )
          ).to.be.revertedWith("Amount must not be 0")
        })
      })

      context("when the receiver address and amount are non-zero", () => {
        context("when the target chain has no tBTC gateway", () => {
          const amount = to1e18(11)

          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            await canonicalTbtc
              .connect(depositor1)
              .approve(gateway.address, amount)
            tx = await gateway
              .connect(depositor1)
              .sendTbtc(amount, recipientChain, recipient, arbiterFee, nonce)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should burn canonical tBTC from the caller", async () => {
            expect(tx)
              .to.emit(canonicalTbtc, "Transfer")
              .withArgs(depositor1.address, ZERO_ADDRESS, amount)
          })

          it("should approve burned amount of wormhole tBTC to the bridge", async () => {
            expect(tx)
              .to.emit(wormholeTbtc, "Approved")
              .withArgs(wormholeBridgeStub.address, amount)
          })

          it("should sent tokens through the bridge", async () => {
            await expect(tx)
              .to.emit(wormholeBridgeStub, "WormholeBridgeStub_transferTokens")
              .withArgs(
                wormholeTbtc.address,
                amount,
                recipientChain,
                recipient,
                arbiterFee,
                nonce
              )
          })

          it("should emit the WormholeTbtcSent event", async () => {
            await expect(tx)
              .to.emit(gateway, "WormholeTbtcSent")
              .withArgs(
                amount,
                recipientChain,
                padTo32Bytes(ZERO_ADDRESS),
                recipient,
                arbiterFee,
                nonce
              )
          })
        })

        context("when the target chain has a tBTC gateway", () => {
          const amount = to1e18(998)
          const targetGateway = "0x4c810fe802d68c6ef0e1291b52fca5812bbc97c9"

          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            await gateway
              .connect(governance)
              .updateGatewayAddress(recipientChain, padTo32Bytes(targetGateway))

            await canonicalTbtc
              .connect(depositor1)
              .approve(gateway.address, amount)
            tx = await gateway
              .connect(depositor1)
              .sendTbtc(amount, recipientChain, recipient, arbiterFee, nonce)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should burn canonical tBTC from the caller", async () => {
            expect(tx)
              .to.emit(canonicalTbtc, "Transfer")
              .withArgs(depositor1.address, ZERO_ADDRESS, amount)
          })

          it("should approve burned amount of wormhole tBTC to the bridge", async () => {
            expect(tx)
              .to.emit(wormholeTbtc, "Approved")
              .withArgs(wormholeBridgeStub.address, amount)
          })

          it("should sent tokens through the bridge", async () => {
            await expect(tx)
              .to.emit(
                wormholeBridgeStub,
                "WormholeBridgeStub_transferTokensWithPayload"
              )
              .withArgs(
                wormholeTbtc.address,
                amount,
                recipientChain,
                padTo32Bytes(targetGateway),
                nonce,
                recipient
              )
          })

          it("should emit the WormholeTbtcSent event", async () => {
            await expect(tx)
              .to.emit(gateway, "WormholeTbtcSent")
              .withArgs(
                amount,
                recipientChain,
                padTo32Bytes(targetGateway),
                recipient,
                arbiterFee,
                nonce
              )
          })
        })

        context("when the amount is below dust", async () => {
          const amount = ethers.BigNumber.from(10000000000).sub(1) // 10^10 - 1

          it("should revert", async () => {
            await expect(
              gateway
                .connect(depositor1)
                .sendTbtc(
                  amount,
                  recipientChain,
                  padTo32Bytes(recipient),
                  arbiterFee,
                  nonce
                )
            ).to.be.revertedWith("Amount too low to bridge")
          })
        })

        context("when the amount is just above the dust", () => {
          const amount = ethers.BigNumber.from(10000000000) // 10^10

          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            await canonicalTbtc
              .connect(depositor1)
              .approve(gateway.address, amount)
            tx = await gateway
              .connect(depositor1)
              .sendTbtc(amount, recipientChain, recipient, arbiterFee, nonce)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should burn canonical tBTC from the caller", async () => {
            expect(tx)
              .to.emit(canonicalTbtc, "Transfer")
              .withArgs(depositor1.address, ZERO_ADDRESS, amount)
          })

          it("should approve burned amount of wormhole tBTC to the bridge", async () => {
            expect(tx)
              .to.emit(wormholeTbtc, "Approved")
              .withArgs(wormholeBridgeStub.address, amount)
          })

          it("should sent the entire amount through the bridge", async () => {
            await expect(tx)
              .to.emit(wormholeBridgeStub, "WormholeBridgeStub_transferTokens")
              .withArgs(
                wormholeTbtc.address,
                amount,
                recipientChain,
                recipient,
                arbiterFee,
                nonce
              )
          })
        })

        context("when the amount has a small dust", () => {
          const amount = ethers.BigNumber.from(10000000001) // 10^10 + 1
          const amountToTake = ethers.BigNumber.from(10000000000)

          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            await canonicalTbtc
              .connect(depositor1)
              .approve(gateway.address, amount)
            tx = await gateway
              .connect(depositor1)
              .sendTbtc(amount, recipientChain, recipient, arbiterFee, nonce)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should burn canonical tBTC from the caller after dropping dust", async () => {
            expect(tx)
              .to.emit(canonicalTbtc, "Transfer")
              .withArgs(depositor1.address, ZERO_ADDRESS, amountToTake)
          })

          it("should approve burned amount of wormhole tBTC to the bridge after dropping dust", async () => {
            expect(tx)
              .to.emit(wormholeTbtc, "Approved")
              .withArgs(wormholeBridgeStub.address, amountToTake)
          })

          it("should drop the dust before sending over the bridge", async () => {
            await expect(tx)
              .to.emit(wormholeBridgeStub, "WormholeBridgeStub_transferTokens")
              .withArgs(
                wormholeTbtc.address,
                amountToTake,
                recipientChain,
                recipient,
                arbiterFee,
                nonce
              )
          })
        })

        context("when the amount has a lot of dust", () => {
          const amount = ethers.BigNumber.from(19999999999) // 2* 10^10 - 1
          const amountToTake = ethers.BigNumber.from(10000000000)

          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            await canonicalTbtc
              .connect(depositor1)
              .approve(gateway.address, amount)
            tx = await gateway
              .connect(depositor1)
              .sendTbtc(amount, recipientChain, recipient, arbiterFee, nonce)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should burn canonical tBTC from the caller after dropping dust", async () => {
            expect(tx)
              .to.emit(canonicalTbtc, "Transfer")
              .withArgs(depositor1.address, ZERO_ADDRESS, amountToTake)
          })

          it("should approve burned amount of wormhole tBTC to the bridge after dropping dust", async () => {
            expect(tx)
              .to.emit(wormholeTbtc, "Approved")
              .withArgs(wormholeBridgeStub.address, amountToTake)
          })

          it("should drop the dust before sending over the bridge", async () => {
            await expect(tx)
              .to.emit(wormholeBridgeStub, "WormholeBridgeStub_transferTokens")
              .withArgs(
                wormholeTbtc.address,
                amountToTake,
                recipientChain,
                recipient,
                arbiterFee,
                nonce
              )
          })
        })
      })
    })
  })

  describe("updateGatewayAddress", () => {
    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          gateway
            .connect(depositor1)
            .updateGatewayAddress(
              10,
              padTo32Bytes("0x999999cf1046e68e36E1aA2E0E07105eDDD1f08E")
            )
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the governance", () => {
      const chainId1 = 7
      const chainId2 = 9
      const gatewayAddress1 = "0xc0ffee254729296a45a3885639ac7e10f9d54979"
      const gatewayAddress2 = "0x999999cf1046e68e36e1aa2e0e07105eddd1f08e"

      let tx1: ContractTransaction
      let tx2: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx1 = await gateway
          .connect(governance)
          .updateGatewayAddress(chainId1, padTo32Bytes(gatewayAddress1))
        tx2 = await gateway
          .connect(governance)
          .updateGatewayAddress(chainId2, padTo32Bytes(gatewayAddress2))
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the gateway address", async () => {
        expect(await gateway.gateways(chainId1)).to.equal(
          padTo32Bytes(gatewayAddress1)
        )
        expect(await gateway.gateways(chainId2)).to.equal(
          padTo32Bytes(gatewayAddress2)
        )
      })

      it("should emit the GatewayAddressUpdated event", async () => {
        await expect(tx1)
          .to.emit(gateway, "GatewayAddressUpdated")
          .withArgs(chainId1, padTo32Bytes(gatewayAddress1))
        await expect(tx2)
          .to.emit(gateway, "GatewayAddressUpdated")
          .withArgs(chainId2, padTo32Bytes(gatewayAddress2))
      })
    })

    // unit test ensuring there is no 0x0 validation preventing from disabling
    // a gateway in case it is needed one day
    context("when disabling gateway", () => {
      const chainId = 17
      const gatewayAddress = "0xc0ffee254729296a45a3885639ac7e10f9d54979"

      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        // first add
        await gateway
          .connect(governance)
          .updateGatewayAddress(chainId, padTo32Bytes(gatewayAddress))
        // then remove
        tx = await gateway
          .connect(governance)
          .updateGatewayAddress(chainId, padTo32Bytes(ZERO_ADDRESS))
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the gateway address", async () => {
        expect(await gateway.gateways(chainId)).to.equal(
          padTo32Bytes(ZERO_ADDRESS)
        )
      })

      it("should emit the GatewayAddressUpdated event", async () => {
        await expect(tx)
          .to.emit(gateway, "GatewayAddressUpdated")
          .withArgs(chainId, padTo32Bytes(ZERO_ADDRESS))
      })
    })
  })

  describe("updateMintingLimit", () => {
    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          gateway.connect(depositor1).updateMintingLimit(10)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the governance", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await gateway.connect(governance).updateMintingLimit(777)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the minting limit", async () => {
        expect(await gateway.mintingLimit()).to.equal(777)
      })

      it("should emit the MintingLimitUpdated event", async () => {
        await expect(tx).to.emit(gateway, "MintingLimitUpdated").withArgs(777)
      })
    })
  })

  describe("toWormholeAddress", () => {
    it("should convert Ethereum address into Wormhole format", async () => {
      const converted = await gateway.toWormholeAddress(
        "0xef3776ccff55072e007c52d72b2763b7e2fcf0e7"
      )
      expect(converted).to.equal(
        "0x000000000000000000000000ef3776ccff55072e007c52d72b2763b7e2fcf0e7"
      )
    })
  })

  describe("fromWormholeAddress", () => {
    it("should convert Wormhole address into Ethereum format", async () => {
      const converted = await gateway.fromWormholeAddress(
        "0x000000000000000000000000ef3776ccff55072e007c52d72b2763b7e2fcf0e7"
      )
      expect(converted).to.equal("0xEf3776CCff55072e007C52d72B2763b7e2fCF0e7")
    })
  })
})
