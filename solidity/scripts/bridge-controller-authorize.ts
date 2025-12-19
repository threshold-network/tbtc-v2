/* eslint-disable no-console */
import { config as dotenvConfig } from "dotenv"
import { ethers, getNamedAccounts } from "hardhat"
import type { Bridge, BridgeGovernance } from "../typechain-types"

dotenvConfig({ override: true })

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

function getRequiredAddress(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (!value || value === ZERO_ADDRESS) {
    throw new Error(`${name} is required and must be non-zero.`)
  }
  return value
}

function getRequiredNumber(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required and must be set.`)
  }
  if (Number.isNaN(Number(value))) {
    throw new Error(`${name} must be a valid number.`)
  }
  return value
}

async function main() {
  console.log(
    "🔧 Authorizing MintBurnGuard as controller via new governance..."
  )

  const { governance: namedGovernance, deployer } = await getNamedAccounts()
  const dryRun =
    process.env.BRIDGE_CONTROLLER_AUTHORIZE_DRY_RUN === "true" ||
    process.env.BRIDGE_CONTROLLER_AUTHORIZE_DRY_RUN === "1"

  const bridgeAddress = getRequiredAddress(
    "BRIDGE_ADDRESS",
    process.env.BRIDGE_PROXY_ADDRESS
  )
  const governanceAddress = getRequiredAddress(
    "BRIDGE_GOVERNANCE_ADDRESS",
    process.env.NEW_BRIDGE_GOVERNANCE
  )
  const controllerAddress = getRequiredAddress(
    "MINTBURN_GUARD_ADDRESS",
    process.env.BRIDGE_CONTROLLER_ADDRESS
  )

  const signerPrivateKey =
    process.env.BRIDGE_GOVERNANCE_PK ?? process.env.GOVERNANCE_PK
  const signer =
    signerPrivateKey && signerPrivateKey.length > 0
      ? new ethers.Wallet(signerPrivateKey, ethers.provider)
      : await ethers.getSigner(namedGovernance ?? deployer)

  const bridge = await ethers.getContractAt<Bridge>("Bridge", bridgeAddress)
  const governance = await ethers.getContractAt<BridgeGovernance>(
    "BridgeGovernance",
    governanceAddress
  )
  const mintBurnGuard = await ethers.getContractAt(
    "MintBurnGuard",
    controllerAddress
  )

  console.log("🔑 Signer:", signer.address)
  console.log("🏛️ Bridge:", bridgeAddress)
  console.log("🏛️ Governance:", governanceAddress)
  console.log("🔧 Controller:", controllerAddress)
  console.log("🧪 Dry run:", dryRun)

  await runVerificationGate({
    bridge,
    governance,
    mintBurnGuard,
    governanceAddress,
    controllerAddress,
    signerAddress: signer.address,
  })

  const preController = await bridge.controllerBalanceIncreaser()
  if (preController.toLowerCase() === controllerAddress.toLowerCase()) {
    console.log("✅ Controller already set; skipping transaction.")
    return
  }

  if (dryRun) {
    console.log(
      "✅ Dry run: verification passed; controller differs but no transaction sent."
    )
    return
  }

  const governanceWithSigner = governance.connect(signer)
  console.log("🧾 Submitting setControllerBalanceIncreaser transaction...")
  const tx = await governanceWithSigner.setControllerBalanceIncreaser(
    controllerAddress
  )
  console.log("📡 Transaction hash:", tx.hash)
  await tx.wait(1)

  const onChainController = await bridge.controllerBalanceIncreaser()
  console.log("📋 Bridge.controllerBalanceIncreaser:", onChainController)
  if (onChainController.toLowerCase() === controllerAddress.toLowerCase()) {
    console.log("🎉 Controller authorization succeeded.")
  } else {
    throw new Error(
      `Controller mismatch after tx: ${onChainController} (expected ${controllerAddress})`
    )
  }

  const hasAuthorizedMapping =
    typeof (bridge as any).authorizedBalanceIncreasers === "function"
  if (hasAuthorizedMapping) {
    const authorized = await (bridge as any).authorizedBalanceIncreasers(
      controllerAddress
    )
    console.log("🎯 authorizedBalanceIncreasers:", authorized)
  } else {
    console.log(
      "ℹ️ Bridge contract does not expose authorizedBalanceIncreasers(); skipping lookup."
    )
  }

  const guardController = await mintBurnGuard.controller()
  console.log("🧿 MintBurnGuard.controller():", guardController)
  if (guardController.toLowerCase() !== governanceAddress.toLowerCase()) {
    console.warn(
      "ℹ️ MintBurnGuard.controller remains different from governance contract."
    )
  }
}

main().catch((error) => {
  console.error("❌ Authorization failed:", error)
  process.exitCode = 1
})

interface VerificationContext {
  bridge: Bridge
  governance: BridgeGovernance
  mintBurnGuard: any
  governanceAddress: string
  controllerAddress: string
  signerAddress: string
}

async function runVerificationGate(ctx: VerificationContext): Promise<void> {
  const {
    bridge,
    governance,
    mintBurnGuard,
    governanceAddress,
    controllerAddress,
    signerAddress,
  } = ctx

  console.log("\n🧪 Verification gate (pre-authorization)")
  const onChainGovernance = await bridge.governance()
  if (onChainGovernance.toLowerCase() !== governanceAddress.toLowerCase()) {
    throw new Error(
      `Bridge.governance()=${onChainGovernance} does not match expected ${governanceAddress}`
    )
  }

  const owner = await governance.owner()
  if (owner.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error(
      `Signer ${signerAddress} is not the owner of BridgeGovernance (${owner})`
    )
  }

  const hasMethod =
    governance.interface.functions["setControllerBalanceIncreaser(address)"]
  if (!hasMethod) {
    throw new Error(
      "BridgeGovernance missing setControllerBalanceIncreaser selector"
    )
  }

  const expectedCap = ethers.utils.parseEther(
    getRequiredNumber("MINT_BURN_GUARD_GLOBAL_CAP")
  )
  const expectedRateLimit = ethers.utils.parseEther(
    getRequiredNumber("MINT_BURN_GUARD_RATE_LIMIT")
  )
  const expectedRateWindow = parseInt(
    getRequiredNumber("MINT_BURN_GUARD_RATE_WINDOW"),
    10
  )

  const [globalCap, rateLimit, rateWindowBn, mintingPaused, totalMinted] =
    await Promise.all([
      mintBurnGuard.globalMintCap(),
      mintBurnGuard.mintRateLimit(),
      mintBurnGuard.mintRateLimitWindow(),
      mintBurnGuard.mintingPaused(),
      mintBurnGuard.totalMinted(),
    ])
  const rateWindow = rateWindowBn.toNumber()

  if (!globalCap.eq(expectedCap)) {
    throw new Error(
      `MintBurnGuard global cap mismatch (${ethers.utils.formatEther(
        globalCap
      )} vs env ${ethers.utils.formatEther(expectedCap)})`
    )
  }

  if (!rateLimit.eq(expectedRateLimit) || rateWindow !== expectedRateWindow) {
    throw new Error(
      "MintBurnGuard rate limit/window does not match configured env values"
    )
  }

  if (mintingPaused) {
    throw new Error("MintBurnGuard is paused; unpause before authorizing.")
  }

  if (totalMinted.gt(globalCap)) {
    throw new Error("MintBurnGuard totalMinted exceeds global cap.")
  }

  const currentController = await bridge.controllerBalanceIncreaser()
  console.log(
    `   Current bridge controller: ${currentController} (expected ${controllerAddress})`
  )

  console.log("✅ Verification gate passed.\n")
}
