import { assert } from "chai"
import { utils } from "ethers"
import { HardhatRuntimeEnvironment } from "hardhat/types"

import deployLockReleaseTokenPool from "../deploy_l1/00_deploy_lock_release_token_pool"
import transferTokenPoolProxyAdminL1 from "../deploy_l1/01_transfer_token_pool_proxy_admin"
import configureTokenPoolChainsL1, {
  BOB_CHAIN_SELECTOR,
  BOB_POOL,
  BOB_TBTC,
} from "../deploy_l1/02_configure_token_pool_chains"
import deployBurnFromMintTokenPool from "../deploy_l2/03_deploy_burn_from_mint_token_pool"
import transferTokenPoolProxyAdminL2 from "../deploy_l2/04_transfer_token_pool_proxy_admin"
import configureTokenPoolChainsL2, {
  ETHEREUM_CHAIN_SELECTOR,
  ETHEREUM_POOL,
  ETHEREUM_TBTC,
} from "../deploy_l2/05_configure_token_pool_chains"

describe("Deprecated BOB CCIP Deploy Scripts", () => {
  const unconditionalScripts = [
    {
      name: "00_deploy_lock_release_token_pool",
      func: deployLockReleaseTokenPool,
    },
    {
      name: "01_transfer_token_pool_proxy_admin (L1)",
      func: transferTokenPoolProxyAdminL1,
    },
    {
      name: "02_configure_token_pool_chains (L1)",
      func: configureTokenPoolChainsL1,
    },
    {
      name: "03_deploy_burn_from_mint_token_pool",
      func: deployBurnFromMintTokenPool,
    },
    {
      name: "04_transfer_token_pool_proxy_admin (L2)",
      func: transferTokenPoolProxyAdminL2,
    },
    {
      name: "05_configure_token_pool_chains (L2)",
      func: configureTokenPoolChainsL2,
    },
  ]

  // Every network these scripts can be pointed at (see hardhat.config.ts).
  // Skipping is asserted against a realistic HRE stub per network rather than
  // an empty object, so a future conditional guard reading hre.network.name
  // cannot pass this suite while still running against a real deployment.
  const networkNames = [
    "hardhat",
    "localhost",
    "mainnet",
    "sepolia",
    "bobMainnet",
    "bobSepolia",
  ]

  for (const script of unconditionalScripts) {
    for (const networkName of networkNames) {
      it(`${script.name} should skip on ${networkName}`, async () => {
        assert.isFunction(
          script.func.skip,
          `Script ${script.name} should define a skip guard`
        )

        const hre = {
          network: { name: networkName, tags: {} },
        } as unknown as HardhatRuntimeEnvironment

        assert.isTrue(
          await script.func.skip!(hre),
          `Script ${script.name} should skip unconditionally (network: ${networkName})`
        )
      })
    }
  }

  describe("recorded BOB CCIP mainnet route", () => {
    it("02_configure_token_pool_chains (L1) pins the BOB mainnet remote", () => {
      assert.equal(BOB_CHAIN_SELECTOR, "3849287863852499584")
      assert.equal(BOB_POOL, "0x36Ee23c94523A05981baaEEaea4BA97cDDe21f6a")
      assert.equal(BOB_TBTC, "0xBBa2eF945D523C4e2608C9E1214C2Cc64D4fc2e2")
    })

    it("05_configure_token_pool_chains (L2) pins the Ethereum mainnet remote", () => {
      assert.equal(ETHEREUM_CHAIN_SELECTOR, "5009297550715157269")
      assert.equal(ETHEREUM_POOL, "0x03E342731c08FDDc34cFb43E91cB3a7e424ee0F6")
      assert.equal(ETHEREUM_TBTC, "0x18084fbA666a33d37592fA2633fD49a74DD93a88")
    })

    it("records every address in EIP-55 checksummed form", () => {
      const addresses = [
        ["BOB_POOL", BOB_POOL],
        ["BOB_TBTC", BOB_TBTC],
        ["ETHEREUM_POOL", ETHEREUM_POOL],
        ["ETHEREUM_TBTC", ETHEREUM_TBTC],
      ]

      for (const [name, address] of addresses) {
        // getAddress on the lower-cased input always returns the canonical
        // EIP-55 form, so this fails (instead of throwing) on a bad checksum.
        assert.equal(
          utils.getAddress(address.toLowerCase()),
          address,
          `${name} is not in EIP-55 checksummed form`
        )
      }
    })
  })
})
