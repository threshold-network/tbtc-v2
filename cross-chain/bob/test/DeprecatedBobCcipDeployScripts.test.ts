import { assert } from "chai"
import { HardhatRuntimeEnvironment } from "hardhat/types"

import deployLockReleaseTokenPool from "../deploy_l1/00_deploy_lock_release_token_pool"
import transferTokenPoolProxyAdminL1 from "../deploy_l1/01_transfer_token_pool_proxy_admin"
import configureTokenPoolChainsL1 from "../deploy_l1/02_configure_token_pool_chains"
import deployBurnFromMintTokenPool from "../deploy_l2/03_deploy_burn_from_mint_token_pool"
import transferTokenPoolProxyAdminL2 from "../deploy_l2/04_transfer_token_pool_proxy_admin"
import configureTokenPoolChainsL2 from "../deploy_l2/05_configure_token_pool_chains"

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
      name: "04_transfer_token_pool_proxy_admin (L2)",
      func: transferTokenPoolProxyAdminL2,
    },
  ]

  const networkGatedScripts = [
    {
      name: "03_deploy_burn_from_mint_token_pool",
      func: deployBurnFromMintTokenPool,
    },
    {
      name: "05_configure_token_pool_chains (L2)",
      func: configureTokenPoolChainsL2,
    },
  ]

  for (const script of unconditionalScripts) {
    it(`${script.name} should always skip`, async () => {
      assert.isFunction(script.func.skip)
      const shouldSkip = await script.func.skip!(
        {} as HardhatRuntimeEnvironment
      )
      assert.isTrue(
        shouldSkip,
        `Script ${script.name} should skip unconditionally`
      )
    })
  }

  for (const script of networkGatedScripts) {
    it(`${script.name} should skip on non-local networks`, async () => {
      assert.isFunction(script.func.skip)

      const shouldSkipHardhat = await script.func.skip!({
        network: { name: "hardhat" },
      } as HardhatRuntimeEnvironment)
      assert.isFalse(
        shouldSkipHardhat,
        `Script ${script.name} should NOT skip on hardhat`
      )

      const shouldSkipLocalhost = await script.func.skip!({
        network: { name: "localhost" },
      } as HardhatRuntimeEnvironment)
      assert.isFalse(
        shouldSkipLocalhost,
        `Script ${script.name} should NOT skip on localhost`
      )

      const shouldSkipMainnet = await script.func.skip!({
        network: { name: "mainnet" },
      } as HardhatRuntimeEnvironment)
      assert.isTrue(
        shouldSkipMainnet,
        `Script ${script.name} should skip on mainnet`
      )
    })
  }
})
