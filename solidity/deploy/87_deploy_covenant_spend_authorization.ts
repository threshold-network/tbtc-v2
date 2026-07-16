import fs from "fs"
import path from "path"
import https from "https"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction, DeployOptions } from "hardhat-deploy/types"
import { utils } from "ethers"

// Sepolia-only deployment of the `CovenantSpendAuthorization`
// registry consulted by `Bridge.defeatFraudChallengeWithCovenantSpend`. This is
// step one of the two-step Stage-3 combined upgrade: the registry must exist and
// be verified before script 88 wires it into the Bridge via the version-6
// reinitializer. The registry has no Bridge binding and no constructor
// arguments; its only deployment-time binding is Ownable ownership, which is
// security-critical (the owner is a fraud-defense root — see the contract's
// TRUST NOTE), so ownership is transferred to an explicitly required address the
// team can actually use to submit `authorizeCovenantSpend`.

const CHAIN_ID_SEPOLIA = 11155111

// EIP-170 / Etherscan V2 endpoint host used for source verification.
const ETHERSCAN_V2_HOST = "api.etherscan.io"

// Submits a Solidity standard-JSON-input verification to the Etherscan V2 API
// (the same hand-rolled path scripts 85/86 use, because `hre.run("verify")`
// does not support the multi-chain V2 endpoint here) and returns the GUID. The
// `runs`/`optimizationUsed` MUST come from the contract's OWN build-info so a
// library compiled at runs=1000 is never submitted as runs=1 (see
// `verifyDeployedContractOrThrow`).
export async function etherscanVerifyV2(
  apiKey: string,
  chainId: number,
  contractAddress: string,
  contractName: string,
  compilerVersion: string,
  solcInputJson: string,
  runs: string,
  optimizationUsed: string
): Promise<string> {
  const queryString = `chainid=${chainId}`
  const postData = new URLSearchParams({
    apikey: apiKey,
    module: "contract",
    action: "verifysourcecode",
    contractaddress: contractAddress,
    sourceCode: solcInputJson,
    codeformat: "solidity-standard-json-input",
    contractname: contractName,
    compilerversion: compilerVersion,
    optimizationUsed,
    runs,
  }).toString()

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: ETHERSCAN_V2_HOST,
        path: `/v2/api?${queryString}`,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let data = ""
        res.on("data", (chunk) => {
          data += chunk
        })
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data)
            if (parsed.status === "1" && parsed.result) {
              resolve(parsed.result)
            } else {
              reject(
                new Error(parsed.result || parsed.message || "Unknown error")
              )
            }
          } catch {
            reject(new Error(`Invalid response: ${data.substring(0, 200)}`))
          }
        })
      }
    )
    req.on("error", reject)
    req.write(postData)
    req.end()
  })
}

// Polls Etherscan V2 `checkverifystatus` for a submitted GUID until it resolves
// or the attempt budget is exhausted. The returned status is evaluated by the
// caller (`verifyDeployedContractOrThrow`), which treats an unconfirmed or
// exhausted-pending result as a hard failure rather than a best-effort log line.
export async function pollEtherscanVerifyStatus(
  apiKey: string,
  chainId: number,
  guid: string,
  attempts = 20
): Promise<string> {
  const query = `chainid=${chainId}&module=contract&action=checkverifystatus&guid=${guid}&apikey=${apiKey}`
  // eslint-disable-next-line no-restricted-syntax
  for (let i = 0; i < attempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await new Promise<string>((resolve, reject) => {
      https
        .get(
          { hostname: ETHERSCAN_V2_HOST, path: `/v2/api?${query}` },
          (res) => {
            let data = ""
            res.on("data", (chunk) => {
              data += chunk
            })
            res.on("end", () => {
              try {
                resolve((JSON.parse(data).result as string) || "")
              } catch {
                reject(new Error(`Invalid status response: ${data}`))
              }
            })
          }
        )
        .on("error", reject)
    })
    if (result && !result.startsWith("Pending")) {
      return result
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 5000))
  }
  return "Pending in queue"
}

// True only for an Etherscan status that confirms the source now matches the
// deployed bytecode. Anything else (a failed compile, a bytecode mismatch, or an
// exhausted-still-pending poll) is treated as not verified.
export function isVerifiedStatus(status: string): boolean {
  const s = status.toLowerCase()
  return s.includes("pass - verified") || s.includes("already verified")
}

// Verification target: a deployed contract plus, for a library-linked contract,
// the solc `settings.libraries` map of its deployed library addresses.
export interface VerificationTarget {
  address: string
  // Fully-qualified name, e.g. "contracts/bridge/Bridge.sol:Bridge".
  fqName: string
  // solc standard-JSON `settings.libraries`: { sourceUnit: { LibName: addr } }.
  libraries?: Record<string, Record<string, string>>
}

// Submits and polls Etherscan V2 verification for one deployed contract, using
// that contract's OWN canonical build-info so the optimizer runs and full
// compiler version always match how it was compiled (a library at runs=1000 is
// never submitted as the Bridge's runs=1, and vice-versa). For a library-linked
// contract the deployed library addresses are injected into the solc input so
// the recompiled+linked bytecode matches the deployed runtime. Throws on a
// missing build-info, a submission error, an exhausted poll, or any non-verified
// status, so callers can treat verification as a real gate.
export async function verifyDeployedContractOrThrow(
  hre: HardhatRuntimeEnvironment,
  apiKey: string,
  chainId: number,
  target: VerificationTarget
): Promise<void> {
  const buildInfo = await hre.artifacts.getBuildInfo(target.fqName)
  if (!buildInfo) {
    throw new Error(
      `No build-info found for ${target.fqName}; cannot verify ${target.address}.`
    )
  }
  // Deep-clone so injecting libraries never mutates the shared build-info cache.
  const input = JSON.parse(JSON.stringify(buildInfo.input))
  const optimizer = (input.settings && input.settings.optimizer) || {}
  const runs = String(optimizer.runs ?? 200)
  const optimizationUsed = optimizer.enabled ? "1" : "0"
  if (target.libraries) {
    input.settings = input.settings || {}
    input.settings.libraries = target.libraries
  }
  const compilerVersion = `v${buildInfo.solcLongVersion}`
  const guid = await etherscanVerifyV2(
    apiKey,
    chainId,
    target.address,
    target.fqName,
    compilerVersion,
    JSON.stringify(input),
    runs,
    optimizationUsed
  )
  const status = await pollEtherscanVerifyStatus(apiKey, chainId, guid)
  if (!isVerifiedStatus(status)) {
    throw new Error(
      `Etherscan verification did not confirm for ${target.fqName} at ` +
        `${target.address}: "${status}".`
    )
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()
  const { ethers } = hre

  const deployOptions: DeployOptions = {
    from: deployer,
    log: true,
    waitConfirmations: 1,
  }

  // The reconstructed controller-mint surface and the Stage-3
  // reinitializer are Sepolia-only. Refuse to run on any other chain so this can
  // never be pointed at mainnet, where there is no corresponding controller
  // extension.
  const chainId = Number(await hre.getChainId())
  if (chainId !== CHAIN_ID_SEPOLIA) {
    throw new Error(
      `Refusing Stage-3 CovenantSpendAuthorization deployment: chain ${chainId} ` +
        `is not Sepolia (${CHAIN_ID_SEPOLIA}). The combined controller-mint ` +
        "artifact and its scripts are Sepolia-only."
    )
  }

  // The registry owner is a fraud-defense root (it can pardon a
  // colluding wallet's unauthorized covenant spend), so it must be a deliberate,
  // operationally usable address the team controls — never an incidental
  // deployer. Require it explicitly.
  const requestedOwnerRaw = process.env.COVENANT_SPEND_AUTHORIZATION_OWNER
  if (!requestedOwnerRaw) {
    throw new Error(
      "COVENANT_SPEND_AUTHORIZATION_OWNER must be set to the address that will " +
        "own the registry (the account-control covenant authority able to submit " +
        "authorizeCovenantSpend)."
    )
  }
  const requestedOwner = utils.getAddress(requestedOwnerRaw)
  if (requestedOwner === ethers.constants.AddressZero) {
    throw new Error(
      "COVENANT_SPEND_AUTHORIZATION_OWNER must not be the zero address."
    )
  }

  console.log(
    "Deploying CovenantSpendAuthorization on Sepolia; requested owner " +
      `${requestedOwner}`
  )

  const registry = await deploy("CovenantSpendAuthorization", {
    ...deployOptions,
    contract:
      "contracts/bridge/CovenantSpendAuthorization.sol:CovenantSpendAuthorization",
    args: [],
  })

  // ---- Runtime-code integrity ----
  const onchainRuntime = await ethers.provider.getCode(registry.address)
  if (onchainRuntime === "0x" || onchainRuntime === "0x0") {
    throw new Error(
      `CovenantSpendAuthorization at ${registry.address} has no runtime code.`
    )
  }
  const artifact = await deployments.getArtifact(
    "contracts/bridge/CovenantSpendAuthorization.sol:CovenantSpendAuthorization"
  )
  const onchainRuntimeHash = utils.keccak256(onchainRuntime)
  const artifactRuntimeHash = utils.keccak256(artifact.deployedBytecode)
  // The registry has no immutables, libraries, or constructor args, so the
  // deployed runtime must match the locally compiled artifact byte for byte.
  if (onchainRuntimeHash !== artifactRuntimeHash) {
    throw new Error(
      "CovenantSpendAuthorization deployed runtime hash " +
        `${onchainRuntimeHash} does not match the compiled artifact ` +
        `${artifactRuntimeHash}.`
    )
  }
  console.log(`  runtime code verified (hash ${onchainRuntimeHash})`)

  // ---- Behavioral smoke check: an unauthorized outpoint reads as false ----
  const registryContract = await ethers.getContractAt(
    "CovenantSpendAuthorization",
    registry.address
  )
  const isAuthorizedForZero = await registryContract.isAuthorized(
    0,
    ethers.constants.HashZero.slice(0, 42),
    0,
    ethers.constants.HashZero
  )
  if (isAuthorizedForZero) {
    throw new Error(
      "Freshly deployed CovenantSpendAuthorization reports isAuthorized(0,..) " +
        "as true; expected a clean, empty registry."
    )
  }
  console.log("  isAuthorized(empty tuple) == false (clean registry)")

  // ---- Ownership: transfer from deployer to the requested owner ----
  const currentOwner = utils.getAddress(await registryContract.owner())
  if (currentOwner === requestedOwner) {
    console.log(`  owner already ${requestedOwner}; no transfer needed`)
  } else if (currentOwner === utils.getAddress(deployer)) {
    console.log(
      `  transferring ownership from deployer ${deployer} to ${requestedOwner}`
    )
    const signer = await ethers.getSigner(deployer)
    const tx = await registryContract
      .connect(signer)
      .transferOwnership(requestedOwner)
    await tx.wait(1)
  } else {
    // Neither the deployer nor the requested owner controls the registry:
    // do not silently reassign; abort so the operator can investigate.
    throw new Error(
      `CovenantSpendAuthorization owner ${currentOwner} is neither the deployer ` +
        `${deployer} nor the requested owner ${requestedOwner}; aborting rather ` +
        "than reassigning ownership."
    )
  }

  const finalOwner = utils.getAddress(await registryContract.owner())
  if (finalOwner !== requestedOwner) {
    throw new Error(
      `CovenantSpendAuthorization final owner ${finalOwner} does not match the ` +
        `requested owner ${requestedOwner}.`
    )
  }
  console.log(`  final owner confirmed: ${finalOwner}`)

  // ---- Etherscan V2 source verification (a real gate when a key is set) ----
  // On a live network a supplied ETHERSCAN_API_KEY makes verification mandatory:
  // a submission error, an exhausted poll, or any non-verified status throws and
  // fails the deployment, rather than being logged and ignored. Without a key the
  // registry is left unverified with an explicit warning to verify it before
  // running script 88. On a local network there is no Etherscan to verify with.
  const etherscanApiKey = process.env.ETHERSCAN_API_KEY
  const isLiveNetwork =
    hre.network.name !== "hardhat" && hre.network.name !== "localhost"
  if (!isLiveNetwork) {
    console.log("  local network; skipping Etherscan verification")
  } else if (!etherscanApiKey) {
    console.log(
      "  ETHERSCAN_API_KEY not set; skipping source verification. Set it and " +
        "verify the registry before running script 88."
    )
  } else {
    console.log(
      `  Submitting Etherscan V2 verification for ${registry.address}...`
    )
    await verifyDeployedContractOrThrow(hre, etherscanApiKey, chainId, {
      address: registry.address,
      fqName:
        "contracts/bridge/CovenantSpendAuthorization.sol:CovenantSpendAuthorization",
    })
    console.log("  Etherscan verification confirmed")
  }

  // ---- Deployment summary ----
  const deploymentSummary = {
    network: hre.network.name,
    timestamp: new Date().toISOString(),
    deployer,
    chainId,
    covenantSpendAuthorization: registry.address,
    runtimeHash: onchainRuntimeHash,
    owner: finalOwner,
    isAuthorizedEmptyTuple: isAuthorizedForZero,
  }
  const summaryDir = path.join(__dirname, "..", "deployments", hre.network.name)
  fs.mkdirSync(summaryDir, { recursive: true })
  const summaryPath = path.join(
    summaryDir,
    `stage3-covenant-authorization-${Date.now()}.json`
  )
  try {
    fs.writeFileSync(summaryPath, JSON.stringify(deploymentSummary, null, 2))
    console.log(`\nDeployment summary saved to: ${summaryPath}`)
  } catch (error) {
    console.log(
      `WARNING: Failed to write deployment summary to ${summaryPath}: ` +
        `${(error as Error).message}`
    )
  }
}

export default func

func.tags = ["DeployCovenantSpendAuthorizationStage3"]
// Explicitly opt-in only. This must never run as part of a normal
// `deployments.fixture()`; it is a deliberate Sepolia operation.
func.skip = async () =>
  process.env.DEPLOY_STAGE3_COVENANT_AUTHORIZATION !== "true"
