import { deployments, ethers, network } from "hardhat"
import type { BigNumber, Contract, ContractTransaction } from "ethers"

const CURRENT_PROTOCOL_ID = ethers.utils.id(
  "tbtc/ecdsa-signature-fraud/router/current-v2"
)
const ZERO_ADDRESS = ethers.constants.AddressZero

type CutoverAction = "inspect" | "begin-drain" | "replace"

function parseAction(value: string | undefined): CutoverAction {
  const action = value ?? "inspect"
  if (
    action !== "inspect" &&
    action !== "begin-drain" &&
    action !== "replace"
  ) {
    throw new Error(
      "ECDSA_CUTOVER_ACTION must be inspect, begin-drain, or replace"
    )
  }
  return action
}

function parseLegacyChallengeKeys(value: string | undefined): BigNumber[] {
  if (value === undefined) {
    throw new Error(
      "ECDSA_LEGACY_FRAUD_CHALLENGE_KEYS must be an explicit JSON array " +
        "(use an empty JSON array only after completing the inventory)"
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error("ECDSA_LEGACY_FRAUD_CHALLENGE_KEYS is not valid JSON")
  }
  if (!Array.isArray(parsed)) {
    throw new Error("ECDSA_LEGACY_FRAUD_CHALLENGE_KEYS must be a JSON array")
  }

  const keys = parsed.map((key) => {
    if (typeof key !== "string" && typeof key !== "number") {
      throw new Error(
        "every legacy fraud challenge key must be a number/string"
      )
    }
    if (typeof key === "number" && !Number.isSafeInteger(key)) {
      throw new Error(
        "numeric legacy fraud challenge keys must be safe integers; " +
          "encode larger keys as strings"
      )
    }
    const result = ethers.BigNumber.from(key)
    if (result.isNegative()) {
      throw new Error("legacy fraud challenge keys cannot be negative")
    }
    return result
  })

  const canonical = keys.map((key) => key.toString())
  if (new Set(canonical).size !== canonical.length) {
    throw new Error("legacy fraud challenge keys contain a duplicate")
  }
  return keys
}

async function readOpenCount(routerAddress: string): Promise<BigNumber> {
  const router = new ethers.Contract(
    routerAddress,
    ["function openFraudChallengeCount() view returns (uint256)"],
    ethers.provider
  )
  return router.openFraudChallengeCount()
}

async function assertReplacement(
  routerAddress: string,
  bridgeAddress: string
): Promise<void> {
  if (routerAddress === ZERO_ADDRESS) {
    throw new Error("replacement router cannot be the zero address")
  }
  if ((await ethers.provider.getCode(routerAddress)) === "0x") {
    throw new Error(`replacement router ${routerAddress} has no bytecode`)
  }

  const router = await ethers.getContractAt("EcdsaFraudRouter", routerAddress)
  const [boundBridge, protocolID, openCount] = await Promise.all([
    router.bridge(),
    router.fraudProtocolID(),
    router.openFraudChallengeCount(),
  ])
  if (boundBridge.toLowerCase() !== bridgeAddress.toLowerCase()) {
    throw new Error(
      `replacement router is bound to ${boundBridge}, not ${bridgeAddress}`
    )
  }
  if (protocolID.toLowerCase() !== CURRENT_PROTOCOL_ID.toLowerCase()) {
    throw new Error(
      `replacement router protocol ${protocolID} is not ${CURRENT_PROTOCOL_ID}`
    )
  }
  if (!openCount.isZero()) {
    throw new Error(
      `replacement router has ${openCount.toString()} open challenge(s)`
    )
  }
}

async function configuredSigner(address: string) {
  const accounts = await ethers.provider.listAccounts()
  if (
    !accounts.some((account) => account.toLowerCase() === address.toLowerCase())
  ) {
    return undefined
  }
  return ethers.getSigner(address)
}

async function submitOrPrint(
  governance: Contract,
  owner: string,
  method: string,
  args: unknown[]
): Promise<ContractTransaction | undefined> {
  const data = governance.interface.encodeFunctionData(method, args)
  console.log(`governance target: ${governance.address}`)
  console.log(`governance data:   ${data}`)

  if (process.env.ECDSA_CUTOVER_EXECUTE !== "true") {
    console.log(
      "inspection only; set ECDSA_CUTOVER_EXECUTE=true to submit from a " +
        "configured BridgeGovernance owner"
    )
    return undefined
  }

  const signer = await configuredSigner(owner)
  if (!signer) {
    throw new Error(
      `BridgeGovernance owner ${owner} is not a configured signer; ` +
        "submit the printed calldata through governance"
    )
  }
  const tx = await signer.sendTransaction({ to: governance.address, data })
  await tx.wait(1)
  console.log(`submitted ${method}: ${tx.hash}`)
  return tx
}

async function main(): Promise<void> {
  const action = parseAction(process.env.ECDSA_CUTOVER_ACTION)
  const bridgeDeployment = await deployments.get("Bridge")
  const governanceDeployment = await deployments.get("BridgeGovernance")
  const replacementDeployment = await deployments.get("EcdsaFraudRouter")
  const replacementAddress = ethers.utils.getAddress(
    process.env.ECDSA_CUTOVER_REPLACEMENT ?? replacementDeployment.address
  )

  const bridge = await ethers.getContractAt("Bridge", bridgeDeployment.address)
  const governance = await ethers.getContractAt(
    "BridgeGovernance",
    governanceDeployment.address
  )

  const [currentRouter, drainRouter] = await (async () => {
    try {
      return await Promise.all([
        bridge.ecdsaFraudRouter(),
        bridge.ecdsaFraudRouterInDrain(),
      ])
    } catch (error) {
      throw new Error(
        "Bridge does not expose the drain-and-replace interface. Upgrade the " +
          `Bridge implementation before cutover. Cause: ${String(error)}`
      )
    }
  })()
  if (currentRouter === ZERO_ADDRESS) {
    throw new Error(
      "Bridge has no existing ECDSA router; use the fresh deployment wiring path"
    )
  }

  const oldOpenCount = await readOpenCount(currentRouter)
  const owner = await governance.owner()
  console.log(`network:             ${network.name}`)
  console.log(`Bridge:              ${bridge.address}`)
  console.log(`BridgeGovernance:    ${governance.address}`)
  console.log(`governance owner:    ${owner}`)
  console.log(`current router:      ${currentRouter}`)
  console.log(`drain router:        ${drainRouter}`)
  console.log(`old open challenges: ${oldOpenCount.toString()}`)
  console.log(`replacement router:  ${replacementAddress}`)

  if (currentRouter.toLowerCase() === replacementAddress.toLowerCase()) {
    if (action !== "inspect") {
      throw new Error(
        "replacement router is already current; no cutover required"
      )
    }
    console.log("replacement router is already current")
    return
  }
  await assertReplacement(replacementAddress, bridge.address)

  if (action === "inspect") {
    console.log("inspection complete; no transaction submitted")
    return
  }

  if (action === "begin-drain") {
    if (drainRouter !== ZERO_ADDRESS) {
      if (drainRouter.toLowerCase() !== currentRouter.toLowerCase()) {
        throw new Error(
          `Bridge drain pins ${drainRouter}, not current router ${currentRouter}`
        )
      }
      console.log(
        "current router is already in drain; no transaction submitted"
      )
      return
    }

    const tx = await submitOrPrint(
      governance,
      owner,
      "beginEcdsaFraudRouterDrain",
      []
    )
    if (tx) {
      const pinned = await bridge.ecdsaFraudRouterInDrain()
      if (pinned.toLowerCase() !== currentRouter.toLowerCase()) {
        throw new Error(`post-drain pin mismatch: ${pinned}`)
      }
    }
    return
  }

  if (drainRouter.toLowerCase() !== currentRouter.toLowerCase()) {
    throw new Error(
      "replacement is NO-GO until begin-drain has pinned the current router"
    )
  }
  if (!oldOpenCount.isZero()) {
    throw new Error(
      `replacement is NO-GO: old router still has ${oldOpenCount.toString()} ` +
        "open challenge(s)"
    )
  }
  if (process.env.ECDSA_LEGACY_FRAUD_INVENTORY_COMPLETE !== "true") {
    throw new Error(
      "replacement is NO-GO until " +
        "ECDSA_LEGACY_FRAUD_INVENTORY_COMPLETE=true is set after independent " +
        "Bridge-resident challenge reconciliation"
    )
  }
  const keys = parseLegacyChallengeKeys(
    process.env.ECDSA_LEGACY_FRAUD_CHALLENGE_KEYS
  )

  const tx = await submitOrPrint(governance, owner, "replaceEcdsaFraudRouter", [
    currentRouter,
    replacementAddress,
    keys,
  ])
  if (!tx) return

  const [newCurrent, newDrain, retired] = await Promise.all([
    bridge.ecdsaFraudRouter(),
    bridge.ecdsaFraudRouterInDrain(),
    bridge.isEcdsaFraudRouterRetired(currentRouter),
  ])
  if (
    newCurrent.toLowerCase() !== replacementAddress.toLowerCase() ||
    newDrain !== ZERO_ADDRESS ||
    !retired
  ) {
    throw new Error(
      `cutover post-check failed: current=${newCurrent}, drain=${newDrain}, ` +
        `retired=${retired}`
    )
  }
  console.log("ECDSA fraud router cutover post-check passed")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
