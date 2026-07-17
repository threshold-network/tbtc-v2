import {
  deployMockContract,
  MockContract,
} from "@ethereum-waffle/mock-contract"
import {
  ArbitrumBitcoinDepositor,
  ArbitrumTBTCToken,
  BitcoinRawTxVectors,
  ChainIdentifier,
  Chains,
  DepositReceipt,
  EthereumAddress,
  Hex,
} from "../../src"
import { MockProvider } from "@ethereum-waffle/provider"
import { assertContractCalledWith } from "../utils/helpers"
import { expect } from "chai"
import { BigNumber } from "ethers"

// ABI imports.
import { abi as ArbitrumBitcoinDepositorABI } from "../../src/lib/arbitrum/artifacts/arbitrumSepolia/ArbitrumL2BitcoinDepositor.json"
import { abi as ArbitrumTBTCTokenABI } from "../../src/lib/arbitrum/artifacts/arbitrumSepolia/ArbitrumTBTC.json"

describe("Arbitrum", () => {
  describe("ArbitrumBitcoinDepositor", () => {
    let depositorContract: MockContract
    let depositorHandle: ArbitrumBitcoinDepositor

    beforeEach(async () => {
      const [signer] = new MockProvider().getWallets()

      depositorContract = await deployMockContract(
        signer,
        `${JSON.stringify(ArbitrumBitcoinDepositorABI)}`
      )

      depositorHandle = new ArbitrumBitcoinDepositor(
        {
          address: depositorContract.address,
          signerOrProvider: signer,
        },
        Chains.Arbitrum.ArbitrumSepolia
      )
    })

    describe("initializeDeposit", () => {
      // Just short byte strings for clarity.
      const depositTx: BitcoinRawTxVectors = {
        version: Hex.from("00000000"),
        inputs: Hex.from("11111111"),
        outputs: Hex.from("22222222"),
        locktime: Hex.from("33333333"),
      }
      const depositOutputIndex: number = 2
      const deposit: DepositReceipt = {
        depositor: EthereumAddress.from(
          "934b98637ca318a4d6e7ca6ffd1690b8e77df637"
        ),
        walletPublicKeyHash: Hex.from(
          "8db50eb52063ea9d98b3eac91489a90f738986f6"
        ),
        refundPublicKeyHash: Hex.from(
          "28e081f285138ccbe389c1eb8985716230129f89"
        ),
        blindingFactor: Hex.from("f9f0c90d00039523"),
        refundLocktime: Hex.from("60bcea61"),
        extraData: Hex.from(
          "00000000000000000000000091fe5b7027c0cA767270bB1A474bA1338BA2A4d2"
        ),
      }
      const vault: ChainIdentifier = EthereumAddress.from(
        "82883a4c7a8dd73ef165deb402d432613615ced4"
      )

      context(
        "when L2 deposit owner is properly encoded in the extra data",
        () => {
          beforeEach(async () => {
            await depositorContract.mock.initializeDeposit.returns()

            await depositorHandle.initializeDeposit(
              depositTx,
              depositOutputIndex,
              deposit,
              vault
            )
          })

          it("should initialize the deposit", async () => {
            assertContractCalledWith(depositorContract, "initializeDeposit", [
              {
                version: "0x00000000",
                inputVector: "0x11111111",
                outputVector: "0x22222222",
                locktime: "0x33333333",
              },
              {
                fundingOutputIndex: 2,
                blindingFactor: "0xf9f0c90d00039523",
                walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
                refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
                refundLocktime: "0x60bcea61",
                vault: "0x82883a4c7a8dd73ef165deb402d432613615ced4",
              },
              "0x91fe5b7027c0cA767270bB1A474bA1338BA2A4d2",
            ])
          })
        }
      )

      context(
        "when L2 deposit owner is not properly encoded in the extra data",
        () => {
          it("should throw", async () => {
            await expect(
              depositorHandle.initializeDeposit(
                depositTx,
                depositOutputIndex,
                {
                  ...deposit,
                  extraData: undefined, // Set empty extra data.
                },
                vault
              )
            ).to.be.rejectedWith("Extra data is required")
          })
        }
      )
    })
  })

  describe("ArbitrumTBTCToken", () => {
    let tokenContract: MockContract
    let tokenHandle: ArbitrumTBTCToken

    beforeEach(async () => {
      const [signer] = new MockProvider().getWallets()

      tokenContract = await deployMockContract(
        signer,
        `${JSON.stringify(ArbitrumTBTCTokenABI)}`
      )

      tokenHandle = new ArbitrumTBTCToken(
        {
          address: tokenContract.address,
          signerOrProvider: signer,
        },
        Chains.Arbitrum.ArbitrumSepolia
      )
    })

    describe("balanceOf", () => {
      let balance: BigNumber

      const identifier: ChainIdentifier = EthereumAddress.from(
        "934b98637ca318a4d6e7ca6ffd1690b8e77df637"
      )

      beforeEach(async () => {
        await tokenContract.mock.balanceOf.returns(10)

        balance = await tokenHandle.balanceOf(identifier)
      })

      it("should call the contract with the right parameter", async () => {
        assertContractCalledWith(tokenContract, "balanceOf", [
          "0x934b98637ca318a4d6e7ca6ffd1690b8e77df637",
        ])
      })

      it("should return the balance", async () => {
        expect(balance).to.equal(10)
      })
    })
  })
})
