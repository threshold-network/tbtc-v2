/* eslint-disable no-param-reassign */
import { BigNumberish, Contract, Signer, constants, utils } from "ethers"

export const COVERAGE_AUTHORIZATION_DOMAIN =
  "tbtc-p2tr-output-key-coverage-authorization-v1"
export const DUAL_SOURCE_CHECKPOINT_DOMAIN =
  "tbtc-complete-p2tr-dual-source-checkpoint-v1"
export const EIP_1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
export const COVERAGE_AUTHORIZATION_TUPLE =
  "tuple(bytes32 inventoryRoot,uint64 inventoryCount,uint64 historyStartBlock,uint64 snapshotBlock,bytes32 snapshotBlockHash,bytes32 sourceIdentity1,address sourceSigner1,bytes32 sourceCheckpointDigest1,bytes32 sourceIdentity2,address sourceSigner2,bytes32 sourceCheckpointDigest2,bytes32 sourceCheckpointCommitment,bytes32 linkedLibrariesCommitment,address implementation,bytes32 implementationCodeHash,address authorizationRegistry,bytes32 authorizationRegistryCodeHash,address fraudRouter,bytes32 fraudRouterCodeHash)"

export async function buildCoverageInitializationPayload(
  bridge: Contract,
  coverageAuthority: string,
  inventoryRoot: string,
  inventoryCount: BigNumberish,
  authorizationRegistry: string,
  fraudRouter: string,
  signer?: Signer,
  contractSignature = "0x",
  sourceSigners?: [Signer, Signer],
  linkedLibrariesCommitment = utils.id("tbtc-test-linked-libraries")
): Promise<{
  payload: string
  digest: string
  signature: string
  sourceSignatures: [string, string]
  authorization: Record<string, unknown>
}> {
  const { provider } = bridge
  const chain = await provider.getNetwork()
  const snapshot = await provider.getBlock("latest")
  const implementationWord = await provider.getStorageAt(
    bridge.address,
    EIP_1967_IMPLEMENTATION_SLOT
  )
  const implementation = utils.getAddress(`0x${implementationWord.slice(-40)}`)
  const implementationCode = await provider.getCode(implementation)
  const registryCode = await provider.getCode(authorizationRegistry)
  const routerCode = await provider.getCode(fraudRouter)
  if (
    implementationCode === "0x" ||
    registryCode === "0x" ||
    routerCode === "0x"
  ) {
    throw new Error("coverage authorization target has no runtime code")
  }
  const governance = await bridge.governance()
  if (!sourceSigners) {
    const accounts = (await provider.listAccounts()).filter(
      (account: string) =>
        account.toLowerCase() !== coverageAuthority.toLowerCase() &&
        account.toLowerCase() !== governance.toLowerCase()
    )
    if (accounts.length < 2) throw new Error("two source signers are required")
    sourceSigners = [
      provider.getSigner(accounts[0]),
      provider.getSigner(accounts[1]),
    ]
  }
  const sources = await Promise.all(
    sourceSigners.map(async (sourceSigner, index) => ({
      identity: utils.keccak256(
        utils.defaultAbiCoder.encode(
          ["string", "string"],
          [`test-source-${index + 1}`, `test-backend-${index + 1}`]
        )
      ),
      signer: await sourceSigner.getAddress(),
      sourceSigner,
    }))
  )
  sources.sort((left, right) =>
    left.identity.toLowerCase() < right.identity.toLowerCase() ? -1 : 1
  )
  const checkpointDigests = sources.map((source) =>
    utils.keccak256(
      utils.defaultAbiCoder.encode(
        ["string", "uint256", "address", "bytes32", "bytes32", "uint64"],
        [
          "tbtc-test-rebuild-checkpoint",
          chain.chainId,
          bridge.address,
          source.identity,
          snapshot.hash,
          snapshot.number,
        ]
      )
    )
  )
  const sourceSignatures = await Promise.all(
    sources.map((source, index) =>
      source.sourceSigner.signMessage(utils.arrayify(checkpointDigests[index]))
    )
  )
  const sourceCheckpoints = sources.map((source, index) =>
    utils.keccak256(
      utils.defaultAbiCoder.encode(
        ["bytes32", "address", "bytes32"],
        [source.identity, source.signer, checkpointDigests[index]]
      )
    )
  )
  const sourceCheckpointCommitment = utils.keccak256(
    utils.defaultAbiCoder.encode(
      ["string", "uint256", "address", "bytes32", "bytes32"],
      [
        DUAL_SOURCE_CHECKPOINT_DOMAIN,
        chain.chainId,
        bridge.address,
        sourceCheckpoints[0],
        sourceCheckpoints[1],
      ]
    )
  )
  const authorization = {
    inventoryRoot,
    inventoryCount,
    historyStartBlock: 0,
    snapshotBlock: snapshot.number,
    snapshotBlockHash: snapshot.hash,
    sourceIdentity1: sources[0].identity,
    sourceSigner1: sources[0].signer,
    sourceCheckpointDigest1: checkpointDigests[0],
    sourceIdentity2: sources[1].identity,
    sourceSigner2: sources[1].signer,
    sourceCheckpointDigest2: checkpointDigests[1],
    sourceCheckpointCommitment,
    linkedLibrariesCommitment,
    implementation,
    implementationCodeHash: utils.keccak256(implementationCode),
    authorizationRegistry,
    authorizationRegistryCodeHash: utils.keccak256(registryCode),
    fraudRouter,
    fraudRouterCodeHash: utils.keccak256(routerCode),
  }
  const historyCommitment = utils.keccak256(
    utils.defaultAbiCoder.encode(
      [
        "bytes32",
        "uint64",
        "uint64",
        "uint64",
        "bytes32",
        "bytes32",
        "bytes32",
      ],
      [
        inventoryRoot,
        inventoryCount,
        authorization.historyStartBlock,
        authorization.snapshotBlock,
        authorization.snapshotBlockHash,
        authorization.sourceCheckpointCommitment,
        authorization.linkedLibrariesCommitment,
      ]
    )
  )
  const codeCommitment = utils.keccak256(
    utils.defaultAbiCoder.encode(
      [
        "bytes32",
        "address",
        "bytes32",
        "address",
        "bytes32",
        "address",
        "bytes32",
      ],
      [
        authorization.linkedLibrariesCommitment,
        implementation,
        authorization.implementationCodeHash,
        authorizationRegistry,
        authorization.authorizationRegistryCodeHash,
        fraudRouter,
        authorization.fraudRouterCodeHash,
      ]
    )
  )
  const digest = utils.keccak256(
    utils.defaultAbiCoder.encode(
      ["string", "uint256", "address", "address", "bytes32", "bytes32"],
      [
        COVERAGE_AUTHORIZATION_DOMAIN,
        chain.chainId,
        bridge.address,
        coverageAuthority,
        historyCommitment,
        codeCommitment,
      ]
    )
  )
  const signature = signer
    ? await signer.signMessage(utils.arrayify(digest))
    : contractSignature
  return {
    digest,
    signature,
    sourceSignatures: [sourceSignatures[0], sourceSignatures[1]],
    authorization,
    payload: utils.defaultAbiCoder.encode(
      ["uint8", COVERAGE_AUTHORIZATION_TUPLE, "bytes", "bytes", "bytes"],
      [0, authorization, sourceSignatures[0], sourceSignatures[1], signature]
    ),
  }
}

export const emptyCoverageRoot = constants.HashZero

/**
 * Rebinds the COMPLETE_V2 fraud router to a different FROST wallet registry.
 *
 * `Wallets.requireCompleteP2TRFraudEvidence` fails closed unless the installed
 * router's authorization registry reports the same `frostRegistry()` the Bridge
 * holds, and `P2TRAuthorizationRegistry.frostRegistry` is immutable. So a suite
 * that swaps in a `FrostWalletRegistryStub` via `resetFrostWalletRegistryForTest`
 * invalidates the pair the bridge fixture installed, and every subsequent FROST
 * wallet registration reverts with `P2TRFraudEvidenceUnavailable()` before it
 * can reach the condition the test is actually asserting.
 *
 * Deploys a matching registry/router pair for `frostRegistryAddress` and points
 * the Bridge at it, so the handshake is satisfied for the real reason rather
 * than by relaxing the guard.
 */
export async function rebindCompleteP2TRFraudRouter(
  bridge: Contract,
  frostRegistryAddress: string,
  walletProposalValidatorAddress: string,
  deployer: Signer,
  ethersLib: {
    getContractFactory: (
      name: string,
      signer?: Signer
    ) => Promise<{ deploy: (...args: unknown[]) => Promise<Contract> }>
  }
): Promise<string> {
  const AuthorizationRegistryFactory = await ethersLib.getContractFactory(
    "P2TRAuthorizationRegistry",
    deployer
  )
  const authorizationRegistry = await AuthorizationRegistryFactory.deploy(
    bridge.address,
    frostRegistryAddress,
    walletProposalValidatorAddress
  )
  await authorizationRegistry.deployed()

  const RouterFactory = await ethersLib.getContractFactory(
    "CompleteP2TRSignatureFraudRouter",
    deployer
  )
  const router = await RouterFactory.deploy(
    bridge.address,
    authorizationRegistry.address
  )
  await router.deployed()

  await bridge.resetP2TRFraudRouterForTest(router.address)
  return router.address
}
