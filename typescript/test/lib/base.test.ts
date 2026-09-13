import {
  BaseBitcoinDepositor,
  BaseTBTCToken,
  BitcoinRawTxVectors,
  ChainIdentifier,
  Chains,
  DepositReceipt,
  EthereumAddress,
  Hex,
} from "../../src"
import chai, { expect } from "chai"
import chaiAsPromised from "chai-as-promised"
import { encodeFunctionData, type Abi, type Address } from "viem"
import { expectContractWrite, MockEvm } from "../utils/mock-evm"
// ABI imports.
import { abi as BaseBitcoinDepositorABI } from "../../src/lib/base/artifacts/baseSepolia/BaseL2BitcoinDepositor.json"
import { abi as BaseTBTCTokenABI } from "../../src/lib/base/artifacts/baseSepolia/BaseTBTC.json"

chai.use(chaiAsPromised)

const depositorAbi = BaseBitcoinDepositorABI as Abi
const tokenAbi = BaseTBTCTokenABI as Abi

describe("Base", () => {
  describe("BaseBitcoinDepositor", () => {
    const depositorAddress: Address =
      "0x256b3cd6d9dc76c05b104ce7cd1c73f2b442ec80"

    let mock: MockEvm
    let depositorHandle: BaseBitcoinDepositor

    beforeEach(async () => {
      mock = new MockEvm()

      depositorHandle = new BaseBitcoinDepositor(
        {
          address: depositorAddress,
          signerOrProvider: mock.asSigner(),
        },
        Chains.Base.BaseSepolia
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

      const expectedFundingTx = {
        version: "0x00000000",
        inputVector: "0x11111111",
        outputVector: "0x22222222",
        locktime: "0x33333333",
      }
      const expectedReveal = {
        fundingOutputIndex: 2,
        blindingFactor: "0xf9f0c90d00039523",
        walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
        refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
        refundLocktime: "0x60bcea61",
        vault: "0x82883a4c7a8dd73ef165deb402d432613615ced4",
      }
      const expectedDepositOwner = "0x91fe5b7027c0ca767270bb1a474ba1338ba2a4d2"

      context(
        "when L2 deposit owner is properly encoded in the extra data",
        () => {
          beforeEach(async () => {
            mock.stubRead(
              depositorAddress,
              depositorAbi,
              "initializeDeposit",
              [expectedFundingTx, expectedReveal, expectedDepositOwner],
              undefined
            )

            await depositorHandle.initializeDeposit(
              depositTx,
              depositOutputIndex,
              deposit,
              vault
            )
          })

          it("should initialize the deposit", async () => {
            expectContractWrite(
              mock,
              depositorAddress,
              depositorAbi,
              "initializeDeposit",
              [expectedFundingTx, expectedReveal, expectedDepositOwner]
            )
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

  describe("BaseTBTCToken", () => {
    const tokenAddress: Address = "0xc3f9f9b1bfd8bbcbcd05bfe4e18f2d8b1d1c9c50"

    let mock: MockEvm
    let tokenHandle: BaseTBTCToken

    beforeEach(async () => {
      mock = new MockEvm()

      tokenHandle = new BaseTBTCToken(
        {
          address: tokenAddress,
          signerOrProvider: mock.asSigner(),
        },
        Chains.Base.BaseSepolia
      )
    })

    describe("balanceOf", () => {
      let balance: bigint

      const identifier: ChainIdentifier = EthereumAddress.from(
        "934b98637ca318a4d6e7ca6ffd1690b8e77df637"
      )

      beforeEach(async () => {
        mock.stubRead(
          tokenAddress,
          tokenAbi,
          "balanceOf",
          ["0x934b98637ca318a4d6e7ca6ffd1690b8e77df637"],
          10n
        )

        balance = await tokenHandle.balanceOf(identifier)
      })

      it("should call the contract with the right parameter", async () => {
        const expectedCalldata = encodeFunctionData({
          abi: tokenAbi,
          functionName: "balanceOf",
          args: ["0x934b98637ca318a4d6e7ca6ffd1690b8e77df637"],
        } as never)
        const matched = mock.requests.some(
          (request) =>
            request.method === "eth_call" &&
            (request.params[0] as { data?: string })?.data === expectedCalldata
        )
        expect(matched, "expected balanceOf eth_call was not issued").to.be.true
      })

      it("should return the balance", async () => {
        expect(balance).to.equal(10n)
      })
    })
  })
})
