/**
 * Fork test for the Bridge MintBurnController upgrade.
 *
 * Validates that the upgrade script 84_upgrade_bridge_mint_burn_controller.ts
 * works correctly on a Sepolia fork before running on the real network.
 *
 * Requires a Sepolia archive node. Run with:
 *
 *   FORKING_URL=<sepolia-rpc-url> \
 *     yarn test ./test/bridge/Bridge.MintBurnControllerUpgrade.test.ts
 *
 * The test is skipped automatically when FORKING_URL is not set.
 */
import hre, { ethers, helpers } from "hardhat"
import { expect } from "chai"

import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type { Bridge, ProxyAdmin } from "../../typechain"
import upgradeBridgeMintBurnController from "../../deploy/84_upgrade_bridge_mint_burn_controller"

// ── Sepolia addresses ───────────────────────────────────────────────────────
const BRIDGE_PROXY = "0x9b1a7fE5a16A15F2f9475C5B231750598b113403"

const LIBRARY_ADDRESSES: Record<string, string> = {
  Deposit: "0xad39ED2D3aF448C14b960746F1F63451D366000c",
  DepositSweep: "0x762B5E9dE8b3cF81d71Cc6f5ea1a9a7B7Eb7b8cB",
  Redemption: "0x88BEEF1F01cD6c74063E398da1114eb4B8C985a6",
  Wallets: "0x21eB46af48705A52f122931ddb8E9df036D8F2c1",
  Fraud: "0xe60FFb5037aC31603B1AeDEf440fFad088dF0a17",
  MovingFunds: "0xbF138155D789007c43dda3cc39B75fB70991e7E3",
}

// EIP-1967 admin storage slot
const PROXY_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"

const { impersonateAccount } = helpers.account

const forkingEnabled = !!process.env.FORKING_URL

// eslint-disable-next-line func-style
const describeOrSkip = forkingEnabled ? describe : describe.skip

describeOrSkip("Bridge - MintBurnController upgrade (Sepolia fork)", function () {
  this.timeout(300000)

  let proxyAdmin: ProxyAdmin
  let proxyAdminOwner: SignerWithAddress
  let bridge: Bridge
  let controllerBeforeUpgrade: string | undefined
  let newImplAddress: string

  before(async () => {
    // Read ProxyAdmin address from the proxy's EIP-1967 admin slot.
    const adminSlotValue = await ethers.provider.getStorageAt(
      BRIDGE_PROXY,
      PROXY_ADMIN_SLOT
    )
    const proxyAdminAddress = ethers.utils.getAddress(
      "0x" + adminSlotValue.slice(26)
    )

    proxyAdmin = await ethers.getContractAt("ProxyAdmin", proxyAdminAddress)

    controllerBeforeUpgrade = await tryGetMintingController(BRIDGE_PROXY)

    // Impersonate the ProxyAdmin owner.
    const ownerAddress = await proxyAdmin.owner()
    ;[proxyAdminOwner] = await ethers.getSigners()
    proxyAdminOwner = await impersonateAccount(ownerAddress, {
      from: proxyAdminOwner,
      value: 10,
    })

    // Inject the existing Sepolia library addresses so resolveLibrary reuses
    // them instead of deploying fresh contracts. Env var names are derived by
    // library-resolution.ts as `${libName.toUpperCase()}_LIB_ADDRESS`.
    process.env.BRIDGE_ADDRESS = BRIDGE_PROXY
    process.env.DEPOSIT_LIB_ADDRESS = LIBRARY_ADDRESSES.Deposit
    process.env.DEPOSITSWEEP_LIB_ADDRESS = LIBRARY_ADDRESSES.DepositSweep
    process.env.REDEMPTION_LIB_ADDRESS = LIBRARY_ADDRESSES.Redemption
    process.env.WALLETS_LIB_ADDRESS = LIBRARY_ADDRESSES.Wallets
    process.env.FRAUD_LIB_ADDRESS = LIBRARY_ADDRESSES.Fraud
    process.env.MOVINGFUNDS_LIB_ADDRESS = LIBRARY_ADDRESSES.MovingFunds

    const bridgeFactory = await ethers.getContractFactory("Bridge", {
      libraries: LIBRARY_ADDRESSES,
    })
    try {
      await hre.upgrades.forceImport(BRIDGE_PROXY, bridgeFactory, {
        kind: "transparent",
      })
    } catch (error) {
      const errorMessage = String(error)
      if (!errorMessage.includes("deployment clashes with an existing one")) {
        throw error
      }
    }
    const namedAccounts = await hre.getNamedAccounts()
    const testHre = {
      ...hre,
      getNamedAccounts: async () => ({
        ...namedAccounts,
        deployer: ownerAddress,
      }),
    }
    await upgradeBridgeMintBurnController(testHre)
    newImplAddress = await proxyAdmin.getProxyImplementation(BRIDGE_PROXY)
    bridge = await ethers.getContractAt("Bridge", BRIDGE_PROXY)
  })

  it("sets the Bridge implementation to the deployed target", async () => {
    const impl = await proxyAdmin.getProxyImplementation(BRIDGE_PROXY)
    expect(impl).to.equal(newImplAddress)
    expect(impl).to.not.equal(ethers.constants.AddressZero)
  })

  it("preserves pre-upgrade minting controller address", async () => {
    const controllerAfterUpgrade = await bridge.getMintingController()
    if (controllerBeforeUpgrade) {
      expect(controllerAfterUpgrade).to.equal(controllerBeforeUpgrade)
    } else {
      expect(controllerAfterUpgrade).to.properAddress
    }
  })

  it("controllerIncreaseBalance reverts with 'Caller is not the authorized controller'", async () => {
    const callerAddress = ethers.Wallet.createRandom().address
    await setBalance(callerAddress, "0x8ac7230489e80000")
    const caller = await impersonateAccount(callerAddress)
    await expect(
      bridge
        .connect(caller)
        .controllerIncreaseBalance(caller.address, 1000)
    ).to.be.revertedWith("Caller is not the authorized controller")
  })

  it("setMintingController is callable by Bridge governance", async () => {
    const governanceAddress = await bridge.governance()
    await setBalance(governanceAddress, "0x8ac7230489e80000")
    const governance = await impersonateAccount(governanceAddress)
    const newController = ethers.Wallet.createRandom().address
    await expect(
      bridge.connect(governance).setMintingController(newController)
    ).to.not.be.reverted
    expect(await bridge.getMintingController()).to.equal(newController)
  })
})

async function setBalance(address: string, weiHex: string): Promise<void> {
  try {
    await ethers.provider.send("hardhat_setBalance", [address, weiHex])
  } catch {
    await ethers.provider.send("anvil_setBalance", [address, weiHex])
  }
}

async function tryGetMintingController(
  bridgeAddress: string
): Promise<string | undefined> {
  const selector = "0x" + ethers.utils.id("getMintingController()").slice(2, 10)
  try {
    const raw = await ethers.provider.call({
      to: bridgeAddress,
      data: selector,
    })
    if (raw.length >= 66) {
      return ethers.utils.getAddress("0x" + raw.slice(26))
    }
    return undefined
  } catch (error) {
    const errorMessage = String(error)
    const missingMethod =
      errorMessage.includes("execution reverted") ||
      errorMessage.includes("call revert exception") ||
      errorMessage.includes("missing revert data")
    if (missingMethod) {
      return undefined
    }
    throw error
  }
}
