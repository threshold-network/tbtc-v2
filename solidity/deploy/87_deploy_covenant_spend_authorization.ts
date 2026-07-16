import fs from "fs"
import path from "path"
import https from "https"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction, DeployOptions } from "hardhat-deploy/types"
import { utils } from "ethers"

// [NEW-STAGE3] Sepolia-only deployment of the `CovenantSpendAuthorization`
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
// does not support the multi-chain V2 endpoint here) and returns the GUID.
async function etherscanVerifyV2(
  apiKey: string,
  chainId: number,
  contractAddress: string,
  contractName: string,
  compilerVersion: string,
  solcInputJson: string
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
    optimizationUsed: "1",
    runs: "1000",
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
// or the attempt budget is exhausted. Verification is best-effort: a failure to
// confirm is logged, not fatal, so a transient Etherscan outage does not block
// the deployment record.
async function pollEtherscanVerifyStatus(
  apiKey: string,
  chainId: number,
  guid: string,
  attempts = 10
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

  // [NEW-STAGE3] The reconstructed controller-mint surface and the Stage-3
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

  // [NEW-STAGE3] The registry owner is a fraud-defense root (it can pardon a
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

  // ---- Etherscan V2 source verification (best-effort) ----
  const etherscanApiKey = process.env.ETHERSCAN_API_KEY
  if (!etherscanApiKey) {
    console.log(
      "  ETHERSCAN_API_KEY not set; skipping source verification. Verify the " +
        "registry before running script 88."
    )
  } else {
    try {
      const buildInfoDir = path.join(__dirname, "..", "build", "build-info")
      const buildInfoFiles = fs
        .readdirSync(buildInfoDir)
        .filter((f) => f.endsWith(".json"))
      let solcInput: string | null = null
      let compilerVersion = ""
      // eslint-disable-next-line no-restricted-syntax
      for (const biFile of buildInfoFiles) {
        const bi = JSON.parse(
          fs.readFileSync(path.join(buildInfoDir, biFile), "utf-8")
        )
        if (
          bi.output?.contracts?.[
            "contracts/bridge/CovenantSpendAuthorization.sol"
          ]?.CovenantSpendAuthorization
        ) {
          solcInput = JSON.stringify(bi.input)
          compilerVersion = `v${bi.solcVersion}`
          break
        }
      }
      if (!solcInput) {
        console.log("  Could not find build-info; skipping verification.")
      } else {
        console.log(
          `  Submitting Etherscan V2 verification for ${registry.address}...`
        )
        const guid = await etherscanVerifyV2(
          etherscanApiKey,
          chainId,
          registry.address,
          "contracts/bridge/CovenantSpendAuthorization.sol:CovenantSpendAuthorization",
          compilerVersion,
          solcInput
        )
        console.log(`  Submitted (GUID ${guid}); polling status...`)
        const status = await pollEtherscanVerifyStatus(
          etherscanApiKey,
          chainId,
          guid
        )
        console.log(`  Verification status: ${status}`)
      }
    } catch (err) {
      console.log(
        `  Verification failed (non-fatal): ${(err as Error).message}`
      )
    }
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
// [NEW-STAGE3] Explicitly opt-in only. This must never run as part of a normal
// `deployments.fixture()`; it is a deliberate Sepolia operation.
func.skip = async () =>
  process.env.DEPLOY_STAGE3_COVENANT_AUTHORIZATION !== "true"
