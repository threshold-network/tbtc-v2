import { viem } from "hardhat"
import { expect } from "chai"
import { getAddress } from "viem"

import type { AbiParameter, Hash, PublicClient } from "viem"
import type { WalletClient } from "@nomicfoundation/hardhat-viem/types"
import type { ContractTypesMap } from "hardhat/types/artifacts"

import { expectEvent, expectNoEvent, expectRevert, normalizeArg } from "./viem"

/**
 * Asserts that a matcher rejected. `chai-as-promised` is a dependency here but
 * is not registered on chai by any plugin the suite loads, so `eventually` is
 * not available and this does the same job in four lines.
 */
async function shouldFail(assertion: Promise<unknown>): Promise<void> {
  let failed = false
  try {
    await assertion
  } catch {
    failed = true
  }
  expect(failed, "expected the matcher to fail, but it passed").to.be.true
}

/**
 * Self-tests for the hand-written viem matchers.
 *
 * A matcher that cannot fail is worse than no matcher: it converts every test
 * that uses it into a test that passes unconditionally. Since these three are
 * ours rather than Nomic's, every one of them is checked here against the
 * mistake it is supposed to catch, not only against the case it should pass.
 */
describe("viem test helpers", () => {
  const uint256: AbiParameter = { name: "value", type: "uint256" }
  const str: AbiParameter = { name: "value", type: "string" }
  const addr: AbiParameter = { name: "who", type: "address" }
  const bytes32: AbiParameter = { name: "digest", type: "bytes32" }

  describe("normalizeArg", () => {
    it("coerces within one ABI type", () => {
      const asNumber = normalizeArg(uint256, 100)
      expect(normalizeArg(uint256, BigInt(100))).to.deep.equal(asNumber)
      expect(normalizeArg(uint256, "100")).to.deep.equal(asNumber)
    })

    it("does not coerce a string parameter into a number", () => {
      // The bug this guards: rendering every numeric as its decimal string
      // made the number 100 satisfy a `string` parameter carrying "100".
      expect(normalizeArg(str, "100")).to.not.deep.equal(
        normalizeArg(uint256, 100)
      )
    })

    it("does not let a numeric string satisfy a different ABI type", () => {
      expect(normalizeArg(bytes32, "100")).to.not.deep.equal(
        normalizeArg(uint256, 100)
      )
      expect(normalizeArg(str, "100")).to.not.deep.equal(
        normalizeArg(bytes32, "100")
      )
    })

    it("checksums addresses and lowercases bytes", () => {
      const lower = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
      expect(normalizeArg(addr, lower)).to.deep.equal(
        normalizeArg(addr, getAddress(lower))
      )
      expect(normalizeArg(bytes32, "0xABCD")).to.deep.equal(
        normalizeArg(bytes32, "0xabcd")
      )
    })

    it("recurses into arrays and tuples", () => {
      const array: AbiParameter = { name: "values", type: "uint256[]" }
      expect(normalizeArg(array, [1, "2", BigInt(3)])).to.deep.equal(
        normalizeArg(array, [BigInt(1), 2, "3"])
      )

      const tuple = {
        name: "pair",
        type: "tuple",
        components: [addr, uint256],
      } as unknown as AbiParameter
      const lower = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
      expect(normalizeArg(tuple, { who: lower, value: 5 })).to.deep.equal(
        normalizeArg(tuple, [getAddress(lower), BigInt(5)])
      )
    })
  })

  describe("against a real receipt", () => {
    let token: ContractTypesMap["TestERC20"]
    let publicClient: PublicClient
    let deployer: WalletClient
    let holder: WalletClient
    let mintTx: Hash

    before(async () => {
      publicClient = await viem.getPublicClient()
      const [firstClient, secondClient] = await viem.getWalletClients()
      deployer = firstClient
      holder = secondClient

      token = await viem.deployContract("TestERC20")
      mintTx = await token.write.mint([holder.account.address, BigInt(1000)], {
        account: deployer.account,
      })
    })

    it("passes on the event it was given", async () => {
      await expectEvent(publicClient, mintTx, token, "Transfer")
      await expectEvent(publicClient, mintTx, token, "Transfer", [
        "0x0000000000000000000000000000000000000000",
        holder.account.address,
        BigInt(1000),
      ])
    })

    it("catches a wrong argument", async () => {
      await shouldFail(
        expectEvent(publicClient, mintTx, token, "Transfer", [
          "0x0000000000000000000000000000000000000000",
          holder.account.address,
          BigInt(999),
        ])
      )
    })

    it("catches a wrong address argument", async () => {
      await shouldFail(
        expectEvent(publicClient, mintTx, token, "Transfer", [
          "0x0000000000000000000000000000000000000000",
          deployer.account.address,
          BigInt(1000),
        ])
      )
    })

    it("catches the wrong number of arguments", async () => {
      await shouldFail(
        expectEvent(publicClient, mintTx, token, "Transfer", [
          holder.account.address,
        ])
      )
    })

    it("catches an event that was never emitted", async () => {
      await shouldFail(expectEvent(publicClient, mintTx, token, "Approval"))
    })

    it("expectNoEvent passes for an absent event and fails for a present one", async () => {
      await expectNoEvent(publicClient, mintTx, token, "Approval")
      await shouldFail(expectNoEvent(publicClient, mintTx, token, "Transfer"))
    })
  })

  describe("expectRevert", () => {
    let token: ContractTypesMap["TestERC20"]
    let holder: WalletClient

    before(async () => {
      const [, secondClient] = await viem.getWalletClients()
      holder = secondClient
      token = await viem.deployContract("TestERC20")
    })

    it("passes on the reason it was given", async () => {
      await expectRevert(
        token.write.mint([holder.account.address, BigInt(1)], {
          account: holder.account,
        }),
        "Ownable: caller is not the owner"
      )
    })

    it("catches a wrong reason", async () => {
      await shouldFail(
        expectRevert(
          token.write.mint([holder.account.address, BigInt(1)], {
            account: holder.account,
          }),
          "some other reason"
        )
      )
    })

    it("catches a call that did not revert at all", async () => {
      await shouldFail(
        expectRevert(
          token.write.approve([holder.account.address, BigInt(1)], {
            account: holder.account,
          }),
          "Ownable: caller is not the owner"
        )
      )
    })
  })
})
