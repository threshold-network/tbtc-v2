import { expect } from "chai"
import { ethers, helpers } from "hardhat"
import type { BigNumber, Contract, ContractTransaction } from "ethers"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type {
  Bridge,
  BridgeGovernance,
  BridgeStub,
  EcdsaFraudRouter,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import { constants } from "../fixtures"
import { loadFixture } from "../helpers/fixture"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { increaseTime } = helpers.time

const BEGIN_AUTHORITY_DOMAIN = ethers.utils.id(
  "tbtc/ecdsa-fraud-cutover/begin-authority/v2"
)
const OWNER_AUTHORIZATION_DOMAIN = ethers.utils.id(
  "tbtc/ecdsa-fraud-cutover/owner-authorization/v1"
)
const SOURCE_ATTESTATION_DOMAIN = ethers.utils.id(
  "tbtc/ecdsa-fraud-cutover/inventory-source-attestation/v1"
)
const SOURCE_CONTEXT_DOMAIN = ethers.utils.id(
  "tbtc/ecdsa-fraud-cutover/source-context/v1"
)
const RECONCILER_CONTEXT_DOMAIN = ethers.utils.id(
  "tbtc/ecdsa-fraud-cutover/reconciler-context/v1"
)
const SOURCE_CHECKPOINT_DOMAIN = ethers.utils.id(
  "tbtc/ecdsa-fraud-cutover/source-checkpoint/v1"
)
const RECONCILER_CHECKPOINT_DOMAIN = ethers.utils.id(
  "tbtc/ecdsa-fraud-cutover/reconciler-checkpoint/v1"
)
const SOURCE_STAGE_DOMAIN = ethers.utils.id(
  "tbtc/ecdsa-fraud-cutover/source-stage/v1"
)
const RECONCILER_STAGE_DOMAIN = ethers.utils.id(
  "tbtc/ecdsa-fraud-cutover/reconciler-stage/v1"
)
const RECONCILER_ENROLLMENT_DOMAIN = ethers.utils.id(
  "tbtc/ecdsa-fraud-cutover/reconciler-enrollment/v1"
)
const RECONCILER_RECOVERY_DOMAIN = ethers.utils.id(
  "tbtc/ecdsa-fraud-cutover/reconciler-recovery/v1"
)

const CONTEXT_TUPLE =
  "tuple(bytes32 durableStoreIdentity,bytes32 endpointIdentity,bytes32 trustDomain,bytes32 policyHash)"
const HISTORY_TUPLE =
  "tuple(bytes32 historyCommitment,bytes32 emitterSetCommitment,uint64 blockCount,uint64 transactionCount,uint64 receiptCount,uint64 logCount,uint64 emitterLogCount,uint64 candidateCallCount,uint64 sourceEventCount,uint64 lifecycleEventCount,bytes32 emitterLogDigest,bytes32 candidateCallDigest,bytes32 sourceEventDigest,bytes32 lifecycleEventDigest,bytes32 legacyLiabilityDigest,uint256 bridgeBalance,uint256 unrelatedBridgeBalance)"
const SNAPSHOT_TUPLE = `tuple(uint64 finalizedBlock,bytes32 finalizedBlockHash,bytes32 challengeSetHash,uint32 challengeCount,uint256 totalEscrow,${HISTORY_TUPLE} history)`
const OWNER_AUTHORIZATION_TUPLE = `tuple(address oldRouter,bytes32 oldRouterCodeHash,address newRouter,bytes32 newRouterCodeHash,uint64 scanStartBlock,address sourceSigner,bytes32 sourceId,${CONTEXT_TUPLE} sourceContext,address reconciler,bytes32 reconcilerSourceId,${CONTEXT_TUPLE} reconcilerContext,bytes32 emitterSetCommitment)`
const PROOF_TUPLE = `tuple(address sourceSigner,bytes32 sourceId,${CONTEXT_TUPLE} sourceContext,address reconciler,bytes32 reconcilerSourceId,${CONTEXT_TUPLE} reconcilerContext,bytes32 manifestPlanHash,uint32 evidenceGeneration,bytes32 evidenceAnchorArtifactHash,bytes32 evidencePredecessorArtifactHash,bytes32 emitterSetCommitment,bytes32 sourcePreflightCommitment,bytes32 sourceCheckpointCommitment,uint64 sourcePreflightFinalizedBlock,bytes32 sourcePreflightFinalizedBlockHash,uint8 maxTailBlocks,bytes sourceManifestSignature,bytes reconcilerManifestSignature)`

type AuthorityContext = {
  durableStoreIdentity: string
  endpointIdentity: string
  trustDomain: string
  policyHash: string
}

type OwnerPlan = {
  oldRouter: Contract
  replacement: EcdsaFraudRouter
  oldCodeHash: string
  newCodeHash: string
  scanStartBlock: number
  sourceSigner: string
  sourceId: string
  sourceContext: AuthorityContext
  sourceSignatureSigner: SignerWithAddress
  reconciler: string
  reconcilerSourceId: string
  reconcilerContext: AuthorityContext
  reconcilerSignatureSigner: SignerWithAddress
  emitterSetCommitment: string
  ownerAuthorizationHash: string
}

type AuthorityPlan = OwnerPlan & {
  sourcePreflightCommitment: string
  sourceCheckpointCommitment: string
  preflightBlock: number
  preflightBlockHash: string
  maxTailBlocks: number
  evidenceGeneration: number
  evidenceAnchorArtifactHash: string
  evidencePredecessorArtifactHash: string
  planHash: string
  encodedProof: string
  drainBlock?: number
}

type SnapshotOptions = {
  challengeCount?: number
  totalEscrow?: BigNumber | number
  historyCommitment?: string
}

async function expectCustomError(
  promise: Promise<unknown>,
  signature: string
): Promise<void> {
  const selector = ethers.utils.id(signature).slice(0, 10).toLowerCase()
  try {
    await promise
    expect.fail(`expected ${signature}`)
  } catch (error) {
    const typed = error as {
      data?: string
      error?: { data?: string }
      message?: string
    }
    expect(
      `${typed.data ?? ""} ${typed.error?.data ?? ""} ${
        typed.message ?? ""
      }`.toLowerCase()
    ).to.include(selector)
  }
}

describe("Bridge - ECDSA fraud router cutover", () => {
  let deployer: SignerWithAddress
  let governance: SignerWithAddress
  let source: SignerWithAddress
  let reconciler: SignerWithAddress
  let keeper: SignerWithAddress
  let pendingReconciler: SignerWithAddress
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let oldRouter: EcdsaFraudRouter

  before(async () => {
    const fixture = await loadFixture(bridgeFixture)
    deployer = fixture.deployer
    governance = fixture.governance
    reconciler = fixture.thirdParty
    const [sourceAuthority, cutoverKeeper, recoveryReconciler] =
      fixture.guardians
    source = sourceAuthority
    keeper = cutoverKeeper
    pendingReconciler = recoveryReconciler
    bridge = fixture.bridge
    bridgeGovernance = fixture.bridgeGovernance
    oldRouter = fixture.ecdsaFraudRouter
  })

  beforeEach(async () => createSnapshot())
  afterEach(async () => restoreSnapshot())

  function authorityContext(label: string): AuthorityContext {
    return {
      durableStoreIdentity: ethers.utils.id(`${label}-durable-store`),
      endpointIdentity: ethers.utils.id(`${label}-endpoint`),
      trustDomain: ethers.utils.id(`${label}-trust-domain`),
      policyHash: ethers.utils.id(`${label}-policy`),
    }
  }

  function contextCommitment(
    domain: string,
    signer: string,
    sourceId: string,
    context: AuthorityContext
  ): string {
    return ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        [
          "bytes32",
          "address",
          "bytes32",
          "bytes32",
          "bytes32",
          "bytes32",
          "bytes32",
        ],
        [
          domain,
          signer,
          sourceId,
          context.durableStoreIdentity,
          context.endpointIdentity,
          context.trustDomain,
          context.policyHash,
        ]
      )
    )
  }

  function authorityCommitment(
    plan: Omit<OwnerPlan, "ownerAuthorizationHash">
  ): string {
    return ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["address", "bytes32", "bytes32", "address", "bytes32", "bytes32"],
        [
          plan.sourceSigner,
          plan.sourceId,
          contextCommitment(
            SOURCE_CONTEXT_DOMAIN,
            plan.sourceSigner,
            plan.sourceId,
            plan.sourceContext
          ),
          plan.reconciler,
          plan.reconcilerSourceId,
          contextCommitment(
            RECONCILER_CONTEXT_DOMAIN,
            plan.reconciler,
            plan.reconcilerSourceId,
            plan.reconcilerContext
          ),
        ]
      )
    )
  }

  async function runtimeCodeHash(contract: Contract): Promise<string> {
    return ethers.utils.keccak256(
      await ethers.provider.getCode(contract.address)
    )
  }

  async function mineBlocks(count: number): Promise<void> {
    if (count > 0) {
      await ethers.provider.send("hardhat_mine", [ethers.utils.hexValue(count)])
    }
  }

  async function deployReplacement(): Promise<EcdsaFraudRouter> {
    const factory = await ethers.getContractFactory(
      "EcdsaFraudRouter",
      deployer
    )
    const replacement = (await factory.deploy(
      bridge.address,
      await bridge.ecdsaFraudRouter()
    )) as EcdsaFraudRouter
    await replacement.deployed()
    return replacement
  }

  async function ownerAction(
    action: number,
    payload: string
  ): Promise<ContractTransaction> {
    return bridgeGovernance
      .connect(governance)
      .processEcdsaFraudCutoverOwnerAction(action, payload)
  }

  async function authorityAction(
    signer: SignerWithAddress,
    action: number,
    payload: string
  ): Promise<ContractTransaction> {
    return bridgeGovernance
      .connect(signer)
      .processEcdsaFraudCutoverAuthorityAction(action, payload)
  }

  async function buildOwnerPlan(
    replacement: EcdsaFraudRouter,
    options: {
      oldRouter?: Contract
      sourceAuthority?: Contract
      reconcilerAuthority?: Contract
      sourceSignatureSigner?: SignerWithAddress
      reconcilerSignatureSigner?: SignerWithAddress
    } = {}
  ): Promise<OwnerPlan> {
    const currentOldRouter = options.oldRouter ?? oldRouter
    const oldCodeHash = await runtimeCodeHash(currentOldRouter)
    const newCodeHash = await runtimeCodeHash(replacement)
    const sourceSigner = options.sourceAuthority?.address ?? source.address
    const reconcilerAddress =
      options.reconcilerAuthority?.address ?? reconciler.address
    const sourceId = ethers.utils.id("independent-source-db")
    const reconcilerSourceId = ethers.utils.id("independent-reconciler-db")
    const sourceContext = authorityContext("source")
    const reconcilerContext = authorityContext("reconciler")
    const emitterSetCommitment = ethers.utils.id("exact-emitter-set")
    const scanStartBlock = 0
    const network = await ethers.provider.getNetwork()
    const governanceDelay = await bridgeGovernance.governanceDelays(0)
    const routerCommitment = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["address", "bytes32", "address", "bytes32"],
        [
          currentOldRouter.address,
          oldCodeHash,
          replacement.address,
          newCodeHash,
        ]
      )
    )
    const partial = {
      oldRouter: currentOldRouter,
      replacement,
      oldCodeHash,
      newCodeHash,
      scanStartBlock,
      sourceSigner,
      sourceId,
      sourceContext,
      sourceSignatureSigner: options.sourceSignatureSigner ?? source,
      reconciler: reconcilerAddress,
      reconcilerSourceId,
      reconcilerContext,
      reconcilerSignatureSigner:
        options.reconcilerSignatureSigner ?? reconciler,
      emitterSetCommitment,
    }
    const ownerAuthorizationHash = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        [
          "bytes32",
          "uint256",
          "address",
          "address",
          "bytes32",
          "uint64",
          "uint256",
          "bytes32",
          "bytes32",
        ],
        [
          OWNER_AUTHORIZATION_DOMAIN,
          network.chainId,
          bridgeGovernance.address,
          bridge.address,
          routerCommitment,
          scanStartBlock,
          governanceDelay,
          authorityCommitment(partial),
          emitterSetCommitment,
        ]
      )
    )
    return { ...partial, ownerAuthorizationHash }
  }

  function ownerAuthorizationPayload(plan: OwnerPlan): string {
    return ethers.utils.defaultAbiCoder.encode(
      [OWNER_AUTHORIZATION_TUPLE],
      [
        {
          oldRouter: plan.oldRouter.address,
          oldRouterCodeHash: plan.oldCodeHash,
          newRouter: plan.replacement.address,
          newRouterCodeHash: plan.newCodeHash,
          scanStartBlock: plan.scanStartBlock,
          sourceSigner: plan.sourceSigner,
          sourceId: plan.sourceId,
          sourceContext: plan.sourceContext,
          reconciler: plan.reconciler,
          reconcilerSourceId: plan.reconcilerSourceId,
          reconcilerContext: plan.reconcilerContext,
          emitterSetCommitment: plan.emitterSetCommitment,
        },
      ]
    )
  }

  async function authorize(plan: OwnerPlan): Promise<void> {
    await (await ownerAction(0, ownerAuthorizationPayload(plan))).wait()
  }

  async function buildAuthorityPlan(
    ownerPlan: OwnerPlan,
    options: {
      preflightAge?: number
      preflightBlockHash?: string
      maxTailBlocks?: number
    } = {}
  ): Promise<AuthorityPlan> {
    const preflightAge = options.preflightAge ?? 63
    const currentBlock = await ethers.provider.getBlockNumber()
    if (currentBlock < preflightAge + 1) {
      await mineBlocks(preflightAge + 1 - currentBlock)
    }
    const preflightBlock =
      (await ethers.provider.getBlockNumber()) - preflightAge
    const canonicalPreflightHash = (
      await ethers.provider.getBlock(preflightBlock)
    ).hash
    const preflightBlockHash =
      options.preflightBlockHash ?? canonicalPreflightHash
    const maxTailBlocks = options.maxTailBlocks ?? 64
    const sourcePreflightCommitment = ethers.utils.id("full-preflight")
    const sourceCheckpointCommitment = ethers.utils.id("exact-checkpoint")
    const evidenceGeneration = 1
    const evidenceAnchorArtifactHash = ethers.utils.id("artifact-anchor")
    const evidencePredecessorArtifactHash = evidenceAnchorArtifactHash
    const sourceContextCommitment = contextCommitment(
      SOURCE_CONTEXT_DOMAIN,
      ownerPlan.sourceSigner,
      ownerPlan.sourceId,
      ownerPlan.sourceContext
    )
    const reconcilerContextCommitment = contextCommitment(
      RECONCILER_CONTEXT_DOMAIN,
      ownerPlan.reconciler,
      ownerPlan.reconcilerSourceId,
      ownerPlan.reconcilerContext
    )
    const sourceCheckpointRoleDigest = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "bytes32", "bytes32"],
        [
          SOURCE_CHECKPOINT_DOMAIN,
          sourceCheckpointCommitment,
          sourceContextCommitment,
        ]
      )
    )
    const reconcilerCheckpointRoleDigest = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "bytes32", "bytes32"],
        [
          RECONCILER_CHECKPOINT_DOMAIN,
          sourceCheckpointCommitment,
          reconcilerContextCommitment,
        ]
      )
    )
    const preflightCommitment = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        [
          "bytes32",
          "bytes32",
          "bytes32",
          "bytes32",
          "uint64",
          "bytes32",
          "uint8",
          "uint32",
          "bytes32",
          "bytes32",
        ],
        [
          ownerPlan.emitterSetCommitment,
          sourcePreflightCommitment,
          sourceCheckpointRoleDigest,
          reconcilerCheckpointRoleDigest,
          preflightBlock,
          preflightBlockHash,
          maxTailBlocks,
          evidenceGeneration,
          evidenceAnchorArtifactHash,
          evidencePredecessorArtifactHash,
        ]
      )
    )
    const planHash = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "bytes32", "bytes32"],
        [
          BEGIN_AUTHORITY_DOMAIN,
          ownerPlan.ownerAuthorizationHash,
          preflightCommitment,
        ]
      )
    )
    const sourceManifestSignature =
      await ownerPlan.sourceSignatureSigner.signMessage(
        ethers.utils.arrayify(planHash)
      )
    const reconcilerManifestSignature =
      await ownerPlan.reconcilerSignatureSigner.signMessage(
        ethers.utils.arrayify(planHash)
      )
    const encodedProof = ethers.utils.defaultAbiCoder.encode(
      [PROOF_TUPLE],
      [
        {
          sourceSigner: ownerPlan.sourceSigner,
          sourceId: ownerPlan.sourceId,
          sourceContext: ownerPlan.sourceContext,
          reconciler: ownerPlan.reconciler,
          reconcilerSourceId: ownerPlan.reconcilerSourceId,
          reconcilerContext: ownerPlan.reconcilerContext,
          manifestPlanHash: planHash,
          evidenceGeneration,
          evidenceAnchorArtifactHash,
          evidencePredecessorArtifactHash,
          emitterSetCommitment: ownerPlan.emitterSetCommitment,
          sourcePreflightCommitment,
          sourceCheckpointCommitment,
          sourcePreflightFinalizedBlock: preflightBlock,
          sourcePreflightFinalizedBlockHash: preflightBlockHash,
          maxTailBlocks,
          sourceManifestSignature,
          reconcilerManifestSignature,
        },
      ]
    )
    return {
      ...ownerPlan,
      sourcePreflightCommitment,
      sourceCheckpointCommitment,
      preflightBlock,
      preflightBlockHash,
      maxTailBlocks,
      evidenceGeneration,
      evidenceAnchorArtifactHash,
      evidencePredecessorArtifactHash,
      planHash,
      encodedProof,
    }
  }

  function beginPayload(plan: AuthorityPlan): string {
    return ethers.utils.defaultAbiCoder.encode(
      [
        "tuple(address oldRouter,bytes32 oldRouterCodeHash,address newRouter,bytes32 newRouterCodeHash,uint64 scanStartBlock,bytes authorityProof)",
      ],
      [
        {
          oldRouter: plan.oldRouter.address,
          oldRouterCodeHash: plan.oldCodeHash,
          newRouter: plan.replacement.address,
          newRouterCodeHash: plan.newCodeHash,
          scanStartBlock: plan.scanStartBlock,
          authorityProof: plan.encodedProof,
        },
      ]
    )
  }

  async function beginDrain(
    replacement: EcdsaFraudRouter,
    ownerOptions: Parameters<typeof buildOwnerPlan>[1] = {},
    proofOptions: Parameters<typeof buildAuthorityPlan>[1] = {}
  ): Promise<AuthorityPlan> {
    const ownerPlan = await buildOwnerPlan(replacement, ownerOptions)
    await authorize(ownerPlan)
    const plan = await buildAuthorityPlan(ownerPlan, proofOptions)
    const receipt = await (
      await authorityAction(keeper, 3, beginPayload(plan))
    ).wait()
    plan.drainBlock = receipt.blockNumber
    return plan
  }

  async function encodeSnapshot(
    plan: AuthorityPlan,
    finalizedBlock: number,
    options: SnapshotOptions = {}
  ): Promise<{
    encodedSnapshot: string
    sourceSignature: string
    reconcilerSignature: string
  }> {
    const block = await ethers.provider.getBlock(finalizedBlock)
    const challengeCount = options.challengeCount ?? 0
    const totalEscrow = options.totalEscrow ?? 0
    const bridgeBalance = await ethers.provider.getBalance(bridge.address)
    const sourceEventCount = challengeCount
    const history = {
      historyCommitment:
        options.historyCommitment ??
        ethers.utils.id("canonical-receipt-history"),
      emitterSetCommitment: plan.emitterSetCommitment,
      blockCount: finalizedBlock - plan.scanStartBlock + 1,
      transactionCount: 0,
      receiptCount: 0,
      logCount: 0,
      emitterLogCount: sourceEventCount,
      candidateCallCount: sourceEventCount,
      sourceEventCount,
      lifecycleEventCount: sourceEventCount,
      emitterLogDigest: ethers.utils.id("emitter-log-digest"),
      candidateCallDigest: ethers.utils.id("candidate-call-digest"),
      sourceEventDigest: ethers.utils.id("source-event-digest"),
      lifecycleEventDigest: ethers.utils.id("lifecycle-event-digest"),
      legacyLiabilityDigest: ethers.utils.id("legacy-liability-digest"),
      bridgeBalance,
      unrelatedBridgeBalance: bridgeBalance.sub(totalEscrow),
    }
    const snapshot = {
      finalizedBlock,
      finalizedBlockHash: block.hash,
      challengeSetHash: ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          [
            "uint256[]",
            "tuple(address challenger,uint256 depositAmount,uint32 reportedAt,bool resolved)[]",
          ],
          [[], []]
        )
      ),
      challengeCount,
      totalEscrow,
      history,
    }
    const encodedSnapshot = ethers.utils.defaultAbiCoder.encode(
      [SNAPSHOT_TUPLE],
      [snapshot]
    )
    const routingCommitment = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "uint64"],
        [plan.oldRouter.address, plan.replacement.address, plan.scanStartBlock]
      )
    )
    const snapshotHash = ethers.utils.keccak256(encodedSnapshot)
    const historyEvidenceHash = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode([HISTORY_TUPLE], [history])
    )
    const network = await ethers.provider.getNetwork()
    const stageDigest = (sourceRole: boolean): string =>
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          [
            "bytes32",
            "bytes32",
            "uint256",
            "address",
            "bytes32",
            "bytes32",
            "bytes32",
            "bytes32",
            "bytes32",
          ],
          [
            SOURCE_ATTESTATION_DOMAIN,
            sourceRole ? SOURCE_STAGE_DOMAIN : RECONCILER_STAGE_DOMAIN,
            network.chainId,
            bridge.address,
            routingCommitment,
            snapshotHash,
            historyEvidenceHash,
            sourceRole
              ? contextCommitment(
                  SOURCE_CONTEXT_DOMAIN,
                  plan.sourceSigner,
                  plan.sourceId,
                  plan.sourceContext
                )
              : contextCommitment(
                  RECONCILER_CONTEXT_DOMAIN,
                  plan.reconciler,
                  plan.reconcilerSourceId,
                  plan.reconcilerContext
                ),
            plan.planHash,
          ]
        )
      )
    return {
      encodedSnapshot,
      sourceSignature: await plan.sourceSignatureSigner.signMessage(
        ethers.utils.arrayify(stageDigest(true))
      ),
      reconcilerSignature: await plan.reconcilerSignatureSigner.signMessage(
        ethers.utils.arrayify(stageDigest(false))
      ),
    }
  }

  function inventoryPayload(snapshot: {
    encodedSnapshot: string
    sourceSignature: string
    reconcilerSignature: string
  }): string {
    return ethers.utils.defaultAbiCoder.encode(
      ["bytes", "bytes", "bytes"],
      [
        snapshot.encodedSnapshot,
        snapshot.sourceSignature,
        snapshot.reconcilerSignature,
      ]
    )
  }

  async function stageAtAge(
    plan: AuthorityPlan,
    age: number,
    finalizedBlock = plan.drainBlock as number,
    options: SnapshotOptions = {}
  ): Promise<ContractTransaction> {
    const currentBlock = await ethers.provider.getBlockNumber()
    await mineBlocks(Math.max(0, finalizedBlock + age - 1 - currentBlock))
    const snapshot = await encodeSnapshot(plan, finalizedBlock, options)
    return authorityAction(keeper, 4, inventoryPayload(snapshot))
  }

  async function migrateEmptyInventory(plan: AuthorityPlan): Promise<void> {
    await (await stageAtAge(plan, 64)).wait()
    const staged = await bridgeGovernance.ecdsaFraudCutoverReadiness()
    await (
      await authorityAction(
        reconciler,
        0,
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32"],
          [staged.inventoryCommitment]
        )
      )
    ).wait()
    await (
      await ownerAction(
        2,
        ethers.utils.defaultAbiCoder.encode(["uint256[]"], [[]])
      )
    ).wait()
  }

  async function executeEmptyCutover(forceBridgeEther = false): Promise<void> {
    const replacement = await deployReplacement()
    const plan = await beginDrain(replacement)
    await (await stageAtAge(plan, 64)).wait()
    const staged = await bridgeGovernance.ecdsaFraudCutoverReadiness()
    if (forceBridgeEther) {
      const force = await (
        await ethers.getContractFactory(
          "EcdsaFraudCutoverForceEtherStub",
          deployer
        )
      ).deploy({ value: 1 })
      await force.forceSend(bridge.address)
    }
    await (
      await authorityAction(
        reconciler,
        0,
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32"],
          [staged.inventoryCommitment]
        )
      )
    ).wait()
    await (
      await ownerAction(
        2,
        ethers.utils.defaultAbiCoder.encode(["uint256[]"], [[]])
      )
    ).wait()
    await (
      await authorityAction(
        reconciler,
        1,
        ethers.utils.defaultAbiCoder.encode(["uint256[]"], [[]])
      )
    ).wait()
    await increaseTime(constants.governanceDelay)
    await (
      await ownerAction(
        4,
        ethers.utils.defaultAbiCoder.encode(["uint256[]"], [[]])
      )
    ).wait()
    expect(await bridge.ecdsaFraudRouter()).to.equal(replacement.address)
    const readiness = await bridgeGovernance.ecdsaFraudCutoverReadiness()
    expect(Number(readiness.phase)).to.equal(0)
    expect(readiness.ownerAuthorizationHash).to.equal(ethers.constants.HashZero)
  }

  it("executes an empty cutover with permissionless begin and staging", async () => {
    await executeEmptyCutover()
  })

  it("does not wedge finalization when unrelated ETH arrives after staging", async () => {
    await executeEmptyCutover(true)
    expect(await ethers.provider.getBalance(bridge.address)).to.equal(1)
  })

  it("does not wedge staging when unrelated ETH arrives after the drain block", async () => {
    const plan = await beginDrain(await deployReplacement())
    const finalizedBlock = plan.drainBlock as number
    const currentBlock = await ethers.provider.getBlockNumber()
    await mineBlocks(Math.max(0, finalizedBlock + 63 - currentBlock))
    const historicalBalance = await ethers.provider.getBalance(bridge.address)
    const snapshot = await encodeSnapshot(plan, finalizedBlock)

    const force = await (
      await ethers.getContractFactory(
        "EcdsaFraudCutoverForceEtherStub",
        deployer
      )
    ).deploy({ value: 1 })
    await force.forceSend(bridge.address)

    await (await authorityAction(keeper, 4, inventoryPayload(snapshot))).wait()
    const staged = await bridgeGovernance.ecdsaFraudCutoverReadiness()
    expect(Number(staged.phase)).to.equal(2)
    expect(await ethers.provider.getBalance(bridge.address)).to.equal(
      historicalBalance.add(1)
    )
  })

  it("keeps exact confirmed inventory replays idempotent while allowing corrected restaging", async () => {
    const plan = await beginDrain(await deployReplacement())
    const finalizedBlock = plan.drainBlock as number
    const currentBlock = await ethers.provider.getBlockNumber()
    await mineBlocks(Math.max(0, finalizedBlock + 63 - currentBlock))
    const snapshot = await encodeSnapshot(plan, finalizedBlock)
    const payload = inventoryPayload(snapshot)

    await (await authorityAction(keeper, 4, payload)).wait()
    const staged = await bridgeGovernance.ecdsaFraudCutoverReadiness()
    await (
      await authorityAction(
        reconciler,
        0,
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32"],
          [staged.inventoryCommitment]
        )
      )
    ).wait()

    await (await authorityAction(keeper, 4, payload)).wait()
    const replayed = await bridgeGovernance.ecdsaFraudCutoverReadiness()
    expect(Number(replayed.phase)).to.equal(3)
    expect(replayed.inventoryCommitment).to.equal(staged.inventoryCommitment)

    const correctedSnapshot = await encodeSnapshot(plan, finalizedBlock, {
      historyCommitment: ethers.utils.id("corrected-canonical-receipt-history"),
    })
    await (
      await authorityAction(keeper, 4, inventoryPayload(correctedSnapshot))
    ).wait()
    const restaged = await bridgeGovernance.ecdsaFraudCutoverReadiness()
    expect(Number(restaged.phase)).to.equal(2)
    expect(restaged.inventoryCommitment).not.to.equal(
      staged.inventoryCommitment
    )
  })

  it("stores the exact owner authorization hash and lets Idle preauthorization be replaced", async () => {
    const first = await buildOwnerPlan(await deployReplacement())
    const second = await buildOwnerPlan(await deployReplacement())
    await authorize(first)
    expect(
      (await bridgeGovernance.ecdsaFraudCutoverReadiness())
        .ownerAuthorizationHash
    ).to.equal(first.ownerAuthorizationHash)

    await authorize(second)
    expect(
      (await bridgeGovernance.ecdsaFraudCutoverReadiness())
        .ownerAuthorizationHash
    ).to.equal(second.ownerAuthorizationHash)

    const staleProof = await buildAuthorityPlan(first)
    await expectCustomError(
      authorityAction(keeper, 3, beginPayload(staleProof)),
      "EcdsaFraudCutoverInvalidSourceAuthority()"
    )

    const currentProof = await buildAuthorityPlan(second)
    await (await authorityAction(keeper, 3, beginPayload(currentProof))).wait()
    expect(
      Number((await bridgeGovernance.ecdsaFraudCutoverReadiness()).phase)
    ).to.equal(1)
  })

  it("enforces 64 <= B-P <= T <= 255", async () => {
    const tooSmall = await buildOwnerPlan(await deployReplacement())
    await authorize(tooSmall)
    const tooSmallProof = await buildAuthorityPlan(tooSmall, {
      maxTailBlocks: 63,
    })
    await expectCustomError(
      authorityAction(keeper, 3, beginPayload(tooSmallProof)),
      "EcdsaFraudCutoverInvalidSourceAuthority()"
    )

    const stale = await buildOwnerPlan(await deployReplacement())
    await authorize(stale)
    const staleProof = await buildAuthorityPlan(stale, {
      preflightAge: 64,
      maxTailBlocks: 64,
    })
    await expectCustomError(
      authorityAction(keeper, 3, beginPayload(staleProof)),
      "EcdsaFraudCutoverInvalidSourceAuthority()"
    )

    const maximum = await buildOwnerPlan(await deployReplacement())
    await authorize(maximum)
    const maximumProof = await buildAuthorityPlan(maximum, {
      maxTailBlocks: 255,
    })
    await (await authorityAction(keeper, 3, beginPayload(maximumProof))).wait()
    const readiness = await bridgeGovernance.ecdsaFraudCutoverReadiness()
    expect(Number(readiness.maxTailBlocks)).to.equal(255)
    expect(readiness.stageDeadlineBlock).to.equal(readiness.drainBlock.add(255))
  })

  it("rejects a noncanonical preflight block hash before drain", async () => {
    const ownerPlan = await buildOwnerPlan(await deployReplacement())
    await authorize(ownerPlan)
    const plan = await buildAuthorityPlan(ownerPlan, {
      preflightBlockHash: ethers.utils.hexZeroPad("0xdead", 32),
    })
    await expectCustomError(
      authorityAction(keeper, 3, beginPayload(plan)),
      "EcdsaFraudCutoverBlockHashMismatch()"
    )
  })

  it("requires staging the exact drain block after 64 confirmations", async () => {
    const plan = await beginDrain(await deployReplacement())
    await expectCustomError(
      stageAtAge(plan, 1),
      "EcdsaFraudCutoverBlockNotFinalized()"
    )
    await expectCustomError(
      stageAtAge(plan, 64, (plan.drainBlock as number) + 1),
      "EcdsaFraudCutoverInvalidScanRange()"
    )
  })

  it("accepts staging at the derived B+255 deadline", async () => {
    const plan = await beginDrain(await deployReplacement())
    await (await stageAtAge(plan, 255)).wait()
    expect(
      Number((await bridgeGovernance.ecdsaFraudCutoverReadiness()).phase)
    ).to.equal(2)
  })

  it("rejects staging after the derived B+255 deadline", async () => {
    const plan = await beginDrain(await deployReplacement())
    await expectCustomError(
      stageAtAge(plan, 256),
      "EcdsaFraudCutoverBlockHashUnavailable()"
    )
  })

  it("does not reapply the finalized-block deadline after staging", async () => {
    const plan = await beginDrain(await deployReplacement())
    await (await stageAtAge(plan, 64)).wait()
    await mineBlocks(256)
    const staged = await bridgeGovernance.ecdsaFraudCutoverReadiness()
    await (
      await authorityAction(
        reconciler,
        0,
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32"],
          [staged.inventoryCommitment]
        )
      )
    ).wait()
    await (
      await ownerAction(
        2,
        ethers.utils.defaultAbiCoder.encode(["uint256[]"], [[]])
      )
    ).wait()
    await (
      await authorityAction(
        reconciler,
        1,
        ethers.utils.defaultAbiCoder.encode(["uint256[]"], [[]])
      )
    ).wait()
    expect(
      Number((await bridgeGovernance.ecdsaFraudCutoverReadiness()).phase)
    ).to.equal(5)
  })

  it("atomically rechecks old-router liabilities at drain execution", async () => {
    const mutable = await (
      await ethers.getContractFactory(
        "MutableEcdsaFraudRouterAncestryStub",
        deployer
      )
    ).deploy(bridge.address)
    await mutable.deployed()
    await bridge.resetEcdsaFraudRouterForTest(mutable.address)
    await bridge.setEcdsaFraudRouterCodeHashForTest(
      await runtimeCodeHash(mutable)
    )
    const replacement = await deployReplacement()
    const ownerPlan = await buildOwnerPlan(replacement, { oldRouter: mutable })
    await authorize(ownerPlan)
    await mutable.setOpenFraudChallengeEscrowForTest(1)
    const plan = await buildAuthorityPlan(ownerPlan)
    await expectCustomError(
      authorityAction(keeper, 3, beginPayload(plan)),
      "EcdsaFraudRouterAncestryHasOpenChallenges(address,uint256,uint256)"
    )
    expect(
      Number((await bridgeGovernance.ecdsaFraudCutoverReadiness()).phase)
    ).to.equal(0)
  })

  it("rejects even a dually attested non-empty activation inventory", async () => {
    const plan = await beginDrain(await deployReplacement())
    await expectCustomError(
      stageAtAge(plan, 64, plan.drainBlock, { challengeCount: 1 }),
      "EcdsaFraudCutoverActivationRequiresEmptyInventory()"
    )
  })

  it("binds reconciler recovery to explicit pending-reconciler enrollment", async () => {
    const plan = await beginDrain(await deployReplacement())
    await migrateEmptyInventory(plan)
    const readiness = await bridgeGovernance.ecdsaFraudCutoverReadiness()
    const pendingSourceId = ethers.utils.id("replacement-reconciler-db")
    const pendingContext = authorityContext("replacement-reconciler")
    const pendingContextCommitment = contextCommitment(
      RECONCILER_CONTEXT_DOMAIN,
      pendingReconciler.address,
      pendingSourceId,
      pendingContext
    )
    const pendingCheckpointRoleDigest = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "bytes32", "bytes32"],
        [
          RECONCILER_CHECKPOINT_DOMAIN,
          plan.sourceCheckpointCommitment,
          pendingContextCommitment,
        ]
      )
    )
    const network = await ethers.provider.getNetwork()
    const enrollmentDigest = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        [
          "bytes32",
          "uint256",
          "address",
          "address",
          "bytes32",
          "bytes32",
          "bytes32",
          "bytes32",
        ],
        [
          RECONCILER_ENROLLMENT_DOMAIN,
          network.chainId,
          bridgeGovernance.address,
          bridge.address,
          readiness.inventoryCommitment,
          plan.planHash,
          authorityCommitment(plan),
          pendingCheckpointRoleDigest,
        ]
      )
    )
    const enrollmentAttestation = await pendingReconciler.signMessage(
      ethers.utils.arrayify(enrollmentDigest)
    )
    const recoveryDigest = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        [
          "bytes32",
          "uint256",
          "address",
          "address",
          "bytes32",
          "bytes32",
          "bytes32",
          "bytes32",
          "bytes32",
        ],
        [
          RECONCILER_RECOVERY_DOMAIN,
          network.chainId,
          bridgeGovernance.address,
          bridge.address,
          readiness.inventoryCommitment,
          plan.planHash,
          authorityCommitment(plan),
          enrollmentDigest,
          ethers.utils.keccak256(enrollmentAttestation),
        ]
      )
    )
    const sourceRecoveryAttestation = await source.signMessage(
      ethers.utils.arrayify(recoveryDigest)
    )
    const recoveryPayload = (
      enrollment: string,
      sourceRecovery: string
    ): string =>
      ethers.utils.defaultAbiCoder.encode(
        ["address", "bytes32", CONTEXT_TUPLE, "bytes", "bytes"],
        [
          pendingReconciler.address,
          pendingSourceId,
          pendingContext,
          enrollment,
          sourceRecovery,
        ]
      )

    const forgedEnrollment = await keeper.signMessage(
      ethers.utils.arrayify(enrollmentDigest)
    )
    await expectCustomError(
      ownerAction(
        3,
        recoveryPayload(forgedEnrollment, sourceRecoveryAttestation)
      ),
      "EcdsaFraudCutoverInvalidReconciler()"
    )

    await (
      await ownerAction(
        3,
        recoveryPayload(enrollmentAttestation, sourceRecoveryAttestation)
      )
    ).wait()
    const pending = await bridgeGovernance.ecdsaFraudCutoverReadiness()
    expect(pending.pendingReconciler).to.equal(pendingReconciler.address)
    expect(pending.pendingReconcilerSourceId).to.equal(pendingSourceId)

    await increaseTime(constants.governanceDelay)
    await (await authorityAction(pendingReconciler, 2, "0x")).wait()
    const recovered = await bridgeGovernance.ecdsaFraudCutoverReadiness()
    expect(recovered.reconciler).to.equal(pendingReconciler.address)
    expect(recovered.reconcilerSourceId).to.equal(pendingSourceId)
    expect(recovered.pendingReconciler).to.equal(ethers.constants.AddressZero)
  })

  it("accepts distinct EIP-1271 source and reconciler authorities", async () => {
    const sourceAuthority = await (
      await ethers.getContractFactory(
        "EcdsaFraudCutoverAuthorityStub",
        deployer
      )
    ).deploy(source.address)
    const reconcilerAuthority = await (
      await ethers.getContractFactory(
        "EcdsaFraudCutoverAuthorityStub",
        deployer
      )
    ).deploy(reconciler.address)
    const plan = await beginDrain(await deployReplacement(), {
      sourceAuthority,
      reconcilerAuthority,
      sourceSignatureSigner: source,
      reconcilerSignatureSigner: reconciler,
    })
    await (await stageAtAge(plan, 64)).wait()
    const readiness = await bridgeGovernance.ecdsaFraudCutoverReadiness()
    const authorityCalldata = bridgeGovernance.interface.encodeFunctionData(
      "processEcdsaFraudCutoverAuthorityAction",
      [
        0,
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32"],
          [readiness.inventoryCommitment]
        ),
      ]
    )
    await reconcilerAuthority
      .connect(reconciler)
      .execute(bridgeGovernance.address, authorityCalldata)
    expect(
      Number((await bridgeGovernance.ecdsaFraudCutoverReadiness()).phase)
    ).to.equal(3)
  })
})
