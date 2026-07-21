/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-expressions */

import fs from "fs"
import os from "os"
import path from "path"
import { expect } from "chai"
import { Wallet, constants, providers, utils } from "ethers"
import { artifacts } from "hardhat"
import deployCompleteP2TRActivation, {
  ACTIVATION_ARTIFACT_SCHEMA,
  AuthorityKind,
  BRIDGE_FROST_REGISTRY_STORAGE_SLOT,
  BRIDGE_LIFECYCLE_ROUTER_STORAGE_SLOT,
  CoverageInventoryDocument,
  EIP_1967_IMPLEMENTATION_SLOT,
  FROST_ARCHIVE_STATE_COMPLETED,
  FROST_ARCHIVE_STATE_FRESH,
  FROST_FRESH_ARCHIVE_SCHEMA_HASH,
  FrostLifecyclePrerequisiteReceipt,
  PreparedCall,
  assertFrostPrerequisiteResumeBinding,
  assertRuntimeCode,
  buildAuthorityEnvelope,
  classifyAuthority,
  deriveCoverageInventory,
  immutableFrostPrerequisiteBinding,
  reconcilePhase,
  resolveFrostLifecycleInstallPlan,
  verifyFrostLifecyclePrerequisites,
} from "../../deploy/88_deploy_complete_p2tr_activation"
import {
  ARCHIVE_CHECKPOINT_SCHEMA,
  ARCHIVE_MANIFEST_SCHEMA_HASH,
  ARCHIVE_PHASE_SCHEMA,
  ARCHIVE_RECONCILER_ATTESTATION_ROLE,
  ARCHIVE_SOURCE_ATTESTATION_ROLE,
  ArchiveManifestV2,
  ArchivePhaseArtifact,
  buildArchiveManifestAttestation,
  buildArchiveMerkleTree,
  hashArchiveCheckpoint,
  hashArchiveManifestAttestation,
  hashArchiveManifestV2,
  hashArchivePhaseArtifact,
} from "../../deploy/54_upgrade_frost_wallet_registry_archive"

describe("Deploy Script 88: COMPLETE_V2 activation", () => {
  const bridge = "0x1000000000000000000000000000000000000001"
  const authority = "0x2000000000000000000000000000000000000002"
  const target = "0x3000000000000000000000000000000000000003"
  const call: PreparedCall = {
    id: "upgrade",
    target,
    value: "0",
    data: "0x12345678",
    description: "upgrade the Bridge",
  }

  const providerWithCode = (code: string): providers.Provider =>
    ({ getCode: async () => code } as unknown as providers.Provider)

  const frostProxy = "0x4000000000000000000000000000000000000004"
  const frostImplementation = "0x5000000000000000000000000000000000000005"
  const lifecycleRouter = "0x6000000000000000000000000000000000000006"
  const registryGovernance = "0x7000000000000000000000000000000000000007"
  const proxyAdmin = "0x8000000000000000000000000000000000000008"
  const archiveAuthority = "0x9000000000000000000000000000000000000009"
  const other = "0xa00000000000000000000000000000000000000a"
  const chainId = "31337"
  const implementationCode = "0x6001600055"
  const lifecycleRouterCode = "0x6002600055"
  const implementationCodeHash = utils.keccak256(implementationCode)
  const frostInterface = new utils.Interface([
    "function governance() view returns (address)",
    "function walletOwner() view returns (address)",
    "function lifecycleOwner() view returns (address)",
    "function getWalletArchiveMigrationManifestHash() view returns (bytes32)",
    "function getWalletArchiveFinalAttestations() view returns (bytes32 sourceAttestationHash,bytes32 reconcilerAttestationHash)",
    "function getWalletArchiveMigration() view returns (uint8 state,address authority,uint256 upgradeBlockNumber,bytes32 oldImplementationCodeHash,bytes32 newImplementationCodeHash,bytes32 walletsRoot,bytes32 historyRoot,bytes32 pendingManifestHash,uint256 expectedCount,uint256 completedCount,bytes32 checkpointHash,uint256 checkpointBlockNumber,uint256 maxTailBlocks)",
  ])
  const lifecycleInterface = new utils.Interface([
    "function bridge() view returns (address)",
  ])
  const temporaryDirectories: string[] = []

  afterEach(() => {
    while (temporaryDirectories.length > 0) {
      fs.rmSync(temporaryDirectories.pop() as string, {
        recursive: true,
        force: true,
      })
    }
  })

  const hash = (label: string): string => utils.id(`deploy88:${label}`)
  const addressWord = (address: string): string => utils.hexZeroPad(address, 32)
  const freshManifestHash = (): string =>
    utils.keccak256(
      utils.defaultAbiCoder.encode(
        ["bytes32", "uint256", "address"],
        [FROST_FRESH_ARCHIVE_SCHEMA_HASH, chainId, frostProxy]
      )
    )

  interface ArchiveMigrationMock {
    state: number
    authority: string
    upgradeBlockNumber: number
    oldImplementationCodeHash: string
    newImplementationCodeHash: string
    walletsRoot: string
    historyRoot: string
    pendingManifestHash: string
    expectedCount: number
    completedCount: number
    checkpointHash: string
    checkpointBlockNumber: number
    maxTailBlocks: number
  }

  interface FrostProviderMock {
    migration: ArchiveMigrationMock
    manifestHash: string
    finalSourceAttestationHash: string
    finalReconcilerAttestationHash: string
    proxyImplementation: string
    bridgeFrostRegistry: string
    bridgeLifecycleRouter: string
    registryLifecycleOwner: string
    registryWalletOwner: string
    routerBridge: string
  }

  const freshProviderState = (): FrostProviderMock => ({
    migration: {
      state: FROST_ARCHIVE_STATE_FRESH,
      authority: constants.AddressZero,
      upgradeBlockNumber: 0,
      oldImplementationCodeHash: constants.HashZero,
      newImplementationCodeHash: constants.HashZero,
      walletsRoot: constants.HashZero,
      historyRoot: constants.HashZero,
      pendingManifestHash: constants.HashZero,
      expectedCount: 0,
      completedCount: 0,
      checkpointHash: constants.HashZero,
      checkpointBlockNumber: 0,
      maxTailBlocks: 0,
    },
    manifestHash: freshManifestHash(),
    finalSourceAttestationHash: constants.HashZero,
    finalReconcilerAttestationHash: constants.HashZero,
    proxyImplementation: frostImplementation,
    bridgeFrostRegistry: frostProxy,
    bridgeLifecycleRouter: constants.AddressZero,
    registryLifecycleOwner: constants.AddressZero,
    registryWalletOwner: bridge,
    routerBridge: bridge,
  })

  const mockFrostProvider = (state: FrostProviderMock): providers.Provider =>
    ({
      getStorageAt: async (address: string, slot: string | number) => {
        if (
          address.toLowerCase() === frostProxy.toLowerCase() &&
          slot.toString() === EIP_1967_IMPLEMENTATION_SLOT
        ) {
          return addressWord(state.proxyImplementation)
        }
        if (address.toLowerCase() === bridge.toLowerCase()) {
          if (Number(slot) === BRIDGE_FROST_REGISTRY_STORAGE_SLOT) {
            return addressWord(state.bridgeFrostRegistry)
          }
          if (Number(slot) === BRIDGE_LIFECYCLE_ROUTER_STORAGE_SLOT) {
            return addressWord(state.bridgeLifecycleRouter)
          }
        }
        return constants.HashZero
      },
      getCode: async (address: string) => {
        if (address.toLowerCase() === frostImplementation.toLowerCase()) {
          return implementationCode
        }
        if (address.toLowerCase() === lifecycleRouter.toLowerCase()) {
          return lifecycleRouterCode
        }
        return "0x"
      },
      call: async ({ to, data }: { to?: string; data?: string }) => {
        if (!to || !data) throw new Error("mock call is missing to/data")
        if (to.toLowerCase() === lifecycleRouter.toLowerCase()) {
          expect(data.slice(0, 10)).to.equal(
            lifecycleInterface.getSighash("bridge")
          )
          return lifecycleInterface.encodeFunctionResult("bridge", [
            state.routerBridge,
          ])
        }
        if (to.toLowerCase() !== frostProxy.toLowerCase()) {
          throw new Error(`unexpected mock call target ${to}`)
        }
        const parsed = frostInterface.parseTransaction({ data })
        switch (parsed.name) {
          case "governance":
            return frostInterface.encodeFunctionResult("governance", [
              registryGovernance,
            ])
          case "walletOwner":
            return frostInterface.encodeFunctionResult("walletOwner", [
              state.registryWalletOwner,
            ])
          case "lifecycleOwner":
            return frostInterface.encodeFunctionResult("lifecycleOwner", [
              state.registryLifecycleOwner,
            ])
          case "getWalletArchiveMigrationManifestHash":
            return frostInterface.encodeFunctionResult(
              "getWalletArchiveMigrationManifestHash",
              [state.manifestHash]
            )
          case "getWalletArchiveFinalAttestations":
            return frostInterface.encodeFunctionResult(
              "getWalletArchiveFinalAttestations",
              [
                state.finalSourceAttestationHash,
                state.finalReconcilerAttestationHash,
              ]
            )
          case "getWalletArchiveMigration": {
            const { migration } = state
            return frostInterface.encodeFunctionResult(
              "getWalletArchiveMigration",
              [
                migration.state,
                migration.authority,
                migration.upgradeBlockNumber,
                migration.oldImplementationCodeHash,
                migration.newImplementationCodeHash,
                migration.walletsRoot,
                migration.historyRoot,
                migration.pendingManifestHash,
                migration.expectedCount,
                migration.completedCount,
                migration.checkpointHash,
                migration.checkpointBlockNumber,
                migration.maxTailBlocks,
              ]
            )
          }
          default:
            throw new Error(`unexpected mock call ${parsed.name}`)
        }
      },
    } as unknown as providers.Provider)

  const freshArchiveArtifact = (): ArchivePhaseArtifact => ({
    schemaVersion: ARCHIVE_PHASE_SCHEMA,
    networkName: "hardhat",
    chainId,
    proxy: frostProxy,
    proxyAdmin,
    proxyAdminOwner: registryGovernance,
    governance: registryGovernance,
    authority: constants.AddressZero,
    oldImplementation: frostImplementation,
    oldImplementationCodeHash: implementationCodeHash,
    implementation: frostImplementation,
    implementationCodeHash,
    frostInactivity: constants.AddressZero,
    frostInactivityCodeHash: constants.HashZero,
    searchFromBlock: 0,
    phase: "executed",
    upgrade: {
      target: proxyAdmin,
      value: "0",
      data: "0x",
      description: "Fresh proxy; no archive upgrade required",
    },
  })

  const writeArchiveArtifact = (artifact: ArchivePhaseArtifact): string => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "deploy88-frost-archive-")
    )
    temporaryDirectories.push(directory)
    const artifactPath = path.join(directory, "archive.json")
    const persistedArtifact = { ...artifact }
    persistedArtifact.artifactHash = hashArchivePhaseArtifact(persistedArtifact)
    fs.writeFileSync(
      artifactPath,
      `${JSON.stringify(persistedArtifact, null, 2)}\n`,
      { mode: 0o600 }
    )
    fs.chmodSync(artifactPath, 0o600)
    return artifactPath
  }

  const verifyFixture = (
    artifact: ArchivePhaseArtifact,
    state: FrostProviderMock,
    implementation = frostImplementation,
    expectedLifecycleRouterCode = lifecycleRouterCode
  ): Promise<FrostLifecyclePrerequisiteReceipt> =>
    verifyFrostLifecyclePrerequisites({
      provider: mockFrostProvider(state),
      chainId,
      networkName: "hardhat",
      bridge,
      frostWalletRegistry: {
        address: frostProxy,
        implementation,
      },
      bridgeLifecycleRouter: {
        address: lifecycleRouter,
        deployedBytecode: expectedLifecycleRouterCode,
      },
      archiveArtifactPath: writeArchiveArtifact(artifact),
    })

  const expectFailure = async (
    operation: Promise<unknown>,
    expectedMessage: string
  ): Promise<void> => {
    try {
      await operation
      expect.fail(`expected failure containing: ${expectedMessage}`)
    } catch (error) {
      expect((error as Error).message).to.include(expectedMessage)
    }
  }

  const completedFixture = (): {
    artifact: ArchivePhaseArtifact
    state: FrostProviderMock
    manifest: ArchiveManifestV2
  } => {
    const source = new Wallet(`0x${"11".repeat(32)}`)
    const reconciler = new Wallet(`0x${"22".repeat(32)}`)
    const archiveEntries = [
      {
        walletID: hash("wallet"),
        dkgResultHash: hash("dkg-result"),
        membersIdsHash: hash("members"),
      },
    ]
    const proofTree = buildArchiveMerkleTree(archiveEntries)
    const checkpoint = {
      schemaVersion: ARCHIVE_CHECKPOINT_SCHEMA,
      chainId,
      registry: frostProxy,
      scanFromBlock: 0,
      checkpointBlockNumber: 10,
      checkpointBlockHash: hash("checkpoint-block"),
      maxTailBlocks: 64,
      upgradeDeadlineBlock: 74,
      history: {
        coverage: {
          chainId: Number(chainId),
          registry: frostProxy,
          scanStartBlock: 0,
          finalizedBlock: 10,
          startParentHash: hash("start-parent"),
          startBlockHash: hash("start-block"),
          finalizedBlockHash: hash("finalized-block"),
          historyCommitment: hash("history-commitment"),
          blockCount: 11,
          transactionCount: 0,
          receiptCount: 0,
          logCount: 0,
          registryLogCount: 0,
          registryLogDigest: hash("registry-log-digest"),
          selectedLogCount: 0,
          selectedLogDigest: hash("selected-log-digest"),
          selectionUpperExclusive: null,
        },
        submitted: [],
        approved: [],
        created: [],
        closed: [],
      },
      entries: [],
      checkpointHash: constants.HashZero,
    }
    checkpoint.checkpointHash = hashArchiveCheckpoint(checkpoint)
    const oldImplementationCodeHash = hash("old-implementation-code")
    const manifest: ArchiveManifestV2 = {
      chainId,
      registry: frostProxy,
      oldImplementationCodeHash,
      newImplementationCodeHash: implementationCodeHash,
      checkpointHash: checkpoint.checkpointHash,
      checkpointBlockNumber: checkpoint.checkpointBlockNumber,
      maxTailBlocks: checkpoint.maxTailBlocks,
      upgradeDeadlineBlock: checkpoint.upgradeDeadlineBlock,
      sourceAttester: source.address,
      sourceAttestationHash: hash("source-checkpoint-attestation"),
      sourceIdentityHash: hash("source-identity"),
      sourceEndpointIdentityHash: hash("source-endpoint"),
      sourceTrustDomainHash: hash("source-trust-domain"),
      sourceEndpointPolicyHash: hash("source-policy"),
      reconcilerAttester: reconciler.address,
      reconcilerAttestationHash: hash("reconciler-checkpoint-attestation"),
      reconcilerIdentityHash: hash("reconciler-identity"),
      reconcilerEndpointIdentityHash: hash("reconciler-endpoint"),
      reconcilerTrustDomainHash: hash("reconciler-trust-domain"),
      reconcilerEndpointPolicyHash: hash("reconciler-policy"),
      upgradeBlockNumber: 11,
      upgradeBlockHash: hash("upgrade-block"),
      upgradeTransactionIndex: 1,
      scanFromBlock: 0,
      scanToBlock: 11,
      historyRoot: hash("combined-history"),
      walletsRoot: proofTree.root,
      walletCount: proofTree.entries.length,
      schemaHash: ARCHIVE_MANIFEST_SCHEMA_HASH,
    }
    const manifestHash = hashArchiveManifestV2(manifest)
    const manifestAttestationRequests = {
      source: buildArchiveManifestAttestation(
        manifest,
        manifestHash,
        ARCHIVE_SOURCE_ATTESTATION_ROLE,
        source.address
      ),
      reconciler: buildArchiveManifestAttestation(
        manifest,
        manifestHash,
        ARCHIVE_RECONCILER_ATTESTATION_ROLE,
        reconciler.address
      ),
    }
    const signedAttestation = (
      signer: Wallet,
      attestation: typeof manifestAttestationRequests.source
    ) => {
      const digest = hashArchiveManifestAttestation(attestation)
      return {
        attestation,
        digest,
        signer: signer.address,
        signature: utils.joinSignature(signer._signingKey().signDigest(digest)),
      }
    }
    const artifact: ArchivePhaseArtifact = {
      schemaVersion: ARCHIVE_PHASE_SCHEMA,
      networkName: "hardhat",
      chainId,
      proxy: frostProxy,
      proxyAdmin,
      proxyAdminOwner: registryGovernance,
      governance: registryGovernance,
      authority: archiveAuthority,
      oldImplementation: other,
      oldImplementationCodeHash,
      implementation: frostImplementation,
      implementationCodeHash,
      frostInactivity: other,
      frostInactivityCodeHash: hash("frost-inactivity-code"),
      searchFromBlock: 0,
      phase: "executed",
      upgradeBlockNumber: manifest.upgradeBlockNumber,
      upgradeBlockHash: manifest.upgradeBlockHash,
      upgradeTransactionIndex: manifest.upgradeTransactionIndex,
      manifest,
      manifestHash,
      proofEntries: proofTree.entries,
      checkpoint,
      manifestAttestationRequests,
      manifestAttestations: {
        source: signedAttestation(source, manifestAttestationRequests.source),
        reconciler: signedAttestation(
          reconciler,
          manifestAttestationRequests.reconciler
        ),
      },
    }
    return {
      artifact,
      manifest,
      state: {
        ...freshProviderState(),
        migration: {
          state: FROST_ARCHIVE_STATE_COMPLETED,
          authority: archiveAuthority,
          upgradeBlockNumber: manifest.upgradeBlockNumber,
          oldImplementationCodeHash,
          newImplementationCodeHash: implementationCodeHash,
          walletsRoot: manifest.walletsRoot,
          historyRoot: manifest.historyRoot,
          pendingManifestHash: manifestHash,
          expectedCount: manifest.walletCount,
          completedCount: manifest.walletCount,
          checkpointHash: manifest.checkpointHash,
          checkpointBlockNumber: manifest.checkpointBlockNumber,
          maxTailBlocks: manifest.maxTailBlocks,
        },
        manifestHash,
        finalSourceAttestationHash: hashArchiveManifestAttestation(
          manifestAttestationRequests.source
        ),
        finalReconcilerAttestationHash: hashArchiveManifestAttestation(
          manifestAttestationRequests.reconciler
        ),
      },
    }
  }

  it("is explicit and disabled unless the operator opts into activation", async () => {
    const previous = process.env.RUN_COMPLETE_P2TR_ACTIVATION
    try {
      delete process.env.RUN_COMPLETE_P2TR_ACTIVATION
      expect(await deployCompleteP2TRActivation.skip!({} as any)).to.be.true
      process.env.RUN_COMPLETE_P2TR_ACTIVATION = "1"
      expect(await deployCompleteP2TRActivation.skip!({} as any)).to.be.false
      expect(deployCompleteP2TRActivation.tags).to.include(
        "CompleteP2TRActivation"
      )
    } finally {
      if (previous === undefined) {
        delete process.env.RUN_COMPLETE_P2TR_ACTIVATION
      } else {
        process.env.RUN_COMPLETE_P2TR_ACTIVATION = previous
      }
    }
  })

  it("rejects old deploy54 artifacts and incomplete archive states", async () => {
    const pendingArtifact = freshArchiveArtifact()
    pendingArtifact.phase = "pending-finality"
    await expectFailure(
      verifyFixture(pendingArtifact, freshProviderState()),
      "archive artifact is not executed"
    )

    const oldArtifact = freshArchiveArtifact()
    oldArtifact.implementation = other
    await expectFailure(
      verifyFixture(oldArtifact, freshProviderState()),
      "proxy implementation address mismatch"
    )

    for (const state of [0, 1, 2]) {
      const providerState = freshProviderState()
      providerState.migration.state = state
      // eslint-disable-next-line no-await-in-loop
      await expectFailure(
        verifyFixture(freshArchiveArtifact(), providerState),
        "state must be exactly Completed or Fresh"
      )
    }

    const zeroManifestState = freshProviderState()
    zeroManifestState.manifestHash = constants.HashZero
    await expectFailure(
      verifyFixture(freshArchiveArtifact(), zeroManifestState),
      "signed manifest hash is zero"
    )
  })

  it("accepts an exact Fresh archive and plans both missing lifecycle bindings", async () => {
    const receipt = await verifyFixture(
      freshArchiveArtifact(),
      freshProviderState()
    )
    expect(receipt.archive.state).to.equal(FROST_ARCHIVE_STATE_FRESH)
    expect(receipt.archive.stateName).to.equal("Fresh")
    expect(receipt.archive.manifestHash).to.equal(freshManifestHash())
    expect(receipt.archive.implementation).to.equal(frostImplementation)
    expect(receipt.archive.implementationCodeHash).to.equal(
      implementationCodeHash
    )
    expect(resolveFrostLifecycleInstallPlan(receipt)).to.deep.equal({
      lifecycleRouterToInstall: lifecycleRouter,
      lifecycleOwnerToInstall: lifecycleRouter,
    })
  })

  it("accepts only the completed archive artifact bound to its signed roots and readbacks", async () => {
    const { artifact, state, manifest } = completedFixture()
    const receipt = await verifyFixture(artifact, state)
    expect(receipt.archive.state).to.equal(FROST_ARCHIVE_STATE_COMPLETED)
    expect(receipt.archive.stateName).to.equal("Completed")
    expect(receipt.archive.manifestHash).to.equal(
      hashArchiveManifestV2(manifest)
    )
    expect(receipt.archive.walletsRoot).to.equal(manifest.walletsRoot)
    expect(receipt.archive.historyRoot).to.equal(manifest.historyRoot)
    expect(receipt.archive.expectedCount).to.equal("1")
    expect(receipt.archive.completedCount).to.equal("1")

    const recovered = completedFixture()
    Reflect.deleteProperty(recovered.artifact, "manifestAttestations")
    expect(
      (await verifyFixture(recovered.artifact, recovered.state)).archive.state
    ).to.equal(FROST_ARCHIVE_STATE_COMPLETED)

    const drifted = completedFixture()
    drifted.state.migration.historyRoot = hash("wrong-history-root")
    await expectFailure(
      verifyFixture(drifted.artifact, drifted.state),
      "artifact/on-chain readback mismatch"
    )
    const unsignedReadback = completedFixture()
    unsignedReadback.state.finalSourceAttestationHash = constants.HashZero
    await expectFailure(
      verifyFixture(unsignedReadback.artifact, unsignedReadback.state),
      "final signed-attestation readback mismatch"
    )
  })

  it("rejects conflicting lifecycle ownership and preserves an in-flight install plan", async () => {
    const wrongOwnerState = freshProviderState()
    wrongOwnerState.registryLifecycleOwner = other
    await expectFailure(
      verifyFixture(freshArchiveArtifact(), wrongOwnerState),
      "different lifecycle owner"
    )

    const wrongBridgeRouterState = freshProviderState()
    wrongBridgeRouterState.bridgeLifecycleRouter = other
    await expectFailure(
      verifyFixture(freshArchiveArtifact(), wrongBridgeRouterState),
      "different lifecycle router"
    )
    await expectFailure(
      verifyFixture(
        freshArchiveArtifact(),
        freshProviderState(),
        frostImplementation,
        "0x6003600055"
      ),
      "runtime codehash/link mismatch"
    )

    const installedState = freshProviderState()
    installedState.bridgeLifecycleRouter = lifecycleRouter
    installedState.registryLifecycleOwner = lifecycleRouter
    const installedReceipt = await verifyFixture(
      freshArchiveArtifact(),
      installedState
    )
    expect(resolveFrostLifecycleInstallPlan(installedReceipt)).to.deep.equal({
      lifecycleRouterToInstall: constants.AddressZero,
      lifecycleOwnerToInstall: constants.AddressZero,
    })
    expect(
      resolveFrostLifecycleInstallPlan(installedReceipt, {
        lifecycleRouterToInstall: lifecycleRouter,
        lifecycleOwnerToInstall: lifecycleRouter,
      })
    ).to.deep.equal({
      lifecycleRouterToInstall: lifecycleRouter,
      lifecycleOwnerToInstall: lifecycleRouter,
    })
  })

  it("rejects immutable prerequisite and lifecycle-plan drift on resume", async () => {
    const receipt = await verifyFixture(
      freshArchiveArtifact(),
      freshProviderState()
    )
    const binding = immutableFrostPrerequisiteBinding(receipt) as {
      archive: Record<string, unknown>
    }
    assertFrostPrerequisiteResumeBinding(binding, receipt)
    expect(() =>
      assertFrostPrerequisiteResumeBinding(
        {
          ...binding,
          archive: {
            ...binding.archive,
            manifestHash: hash("resume-drift"),
          },
        },
        receipt
      )
    ).to.throw("prerequisite resume drift")
    expect(() => resolveFrostLifecycleInstallPlan(receipt, {})).to.throw(
      "missing the FROST lifecycle install plan"
    )
    await expectFailure(
      verifyFixture(freshArchiveArtifact(), freshProviderState(), other),
      "proxy implementation address mismatch"
    )
  })

  it("supports calldata preparation for configured and external EOA authorities", async () => {
    expect(
      await classifyAuthority(providerWithCode("0x"), authority, [authority])
    ).to.equal("eoa")
    expect(
      await classifyAuthority(providerWithCode("0x"), authority, [])
    ).to.equal("eoa")

    const envelope = buildAuthorityEnvelope(call, authority, "eoa", {
      chainId: "1",
      bridge,
      phase: "upgrade",
    })
    expect(envelope.kind).to.equal("eoa")
    expect(envelope.inner).to.deep.equal(call)
    expect(envelope.safeTransaction).to.be.undefined
    expect(envelope.timelockSchedule).to.be.undefined
  })

  for (const kind of ["safe", "timelock"] as Array<
    Exclude<AuthorityKind, "eoa">
  >) {
    it(`prepares deterministic ${kind} contract-authority calldata without a local signer`, async () => {
      expect(
        await classifyAuthority(
          providerWithCode("0x60006000"),
          authority,
          [],
          kind
        )
      ).to.equal(kind)
      const first = buildAuthorityEnvelope(call, authority, kind, {
        chainId: "1",
        bridge,
        phase: "upgrade",
        delay: "86400",
      })
      const second = buildAuthorityEnvelope(call, authority, kind, {
        chainId: "1",
        bridge,
        phase: "upgrade",
        delay: "86400",
      })
      expect(first).to.deep.equal(second)
      if (kind === "safe") {
        expect(first.safeTransaction).to.deep.equal({
          to: target,
          value: "0",
          data: call.data,
          operation: 0,
        })
      } else {
        expect(first.timelockOperationID).to.match(/^0x[0-9a-f]{64}$/)
        expect(first.timelockSchedule?.target).to.equal(authority)
        expect(first.timelockExecute?.target).to.equal(authority)
        expect(first.timelockSchedule?.data.slice(0, 10)).to.equal(
          utils
            .id("schedule(address,uint256,bytes,bytes32,bytes32,uint256)")
            .slice(0, 10)
        )
        expect(first.timelockExecute?.data.slice(0, 10)).to.equal(
          utils
            .id("execute(address,uint256,bytes,bytes32,bytes32)")
            .slice(0, 10)
        )
      }
    })
  }

  it("rejects an unclassified contract owner instead of guessing its authority model", async () => {
    try {
      await classifyAuthority(providerWithCode("0x60006000"), authority, [])
      expect.fail("expected explicit authority-kind failure")
    } catch (error) {
      expect((error as Error).message).to.include("explicit safe/timelock")
    }
  })

  it("reconciles prepared/pending/executed crash resumes from exact readbacks", () => {
    const candidate = {
      id: "upgrade",
      status: "prepared" as const,
      calls: [
        buildAuthorityEnvelope(call, authority, "safe", {
          chainId: "1",
          bridge,
          phase: "upgrade",
        }),
      ],
      transactionHashes: [],
    }
    const pending = { ...candidate, status: "pending" as const }
    expect(reconcilePhase(pending, candidate, false).status).to.equal("pending")
    expect(reconcilePhase(pending, candidate, true).status).to.equal("executed")
    expect(() =>
      reconcilePhase(
        { ...candidate, status: "executed" as const },
        candidate,
        false
      )
    ).to.throw("Activation state regression")
  })

  it("rejects wrong runtime codehashes or linked bytecode and enforces EIP-170", () => {
    const code = "0x6001600055"
    const receipt = assertRuntimeCode("Bridge", target, code, code)
    expect(receipt.runtimeBytes).to.equal(5)
    expect(receipt.runtimeCodeHash).to.equal(utils.keccak256(code))
    expect(() =>
      assertRuntimeCode("Bridge", target, code, "0x6002600055")
    ).to.throw("runtime codehash/link mismatch")
    const oversized = `0x${"00".repeat(24_577)}`
    expect(() =>
      assertRuntimeCode("Bridge", target, oversized, oversized)
    ).to.throw("exceeds EIP-170")
    const lastRuntimeWithHeadroom = `0x${"00".repeat(24_064)}`
    expect(
      assertRuntimeCode(
        "CompleteRouter",
        target,
        lastRuntimeWithHeadroom,
        lastRuntimeWithHeadroom
      ).runtimeBytes
    ).to.equal(24_064)
    const insufficientHeadroom = `0x${"00".repeat(24_065)}`
    expect(() =>
      assertRuntimeCode(
        "CompleteRouter",
        target,
        insufficientHeadroom,
        insufficientHeadroom
      )
    ).to.throw("leaves less than 512 bytes")
  })

  it("retains 512 bytes of EIP-170 headroom in every COMPLETE production artifact", async () => {
    const productionArtifacts = [
      "contracts/bridge/P2TRReservation.sol:P2TRReservation",
      "contracts/bridge/P2TRPreSigning.sol:P2TRPreSigning",
      "contracts/bridge/Deposit.sol:Deposit",
      "contracts/bridge/DepositSweep.sol:DepositSweep",
      "contracts/bridge/Redemption.sol:Redemption",
      "contracts/bridge/Wallets.sol:Wallets",
      "contracts/bridge/Fraud.sol:Fraud",
      "contracts/bridge/MovingFunds.sol:MovingFunds",
      "contracts/bridge/Bridge.sol:Bridge",
      "contracts/bridge/EcdsaFraudRouter.sol:EcdsaFraudRouter",
      "contracts/bridge/P2TRAuthorizationRegistry.sol:P2TRAuthorizationRegistry",
      "contracts/bridge/CompleteP2TRSignatureFraudRouter.sol:CompleteP2TRSignatureFraudRouter",
      "contracts/bridge/BridgeLifecycleRouter.sol:BridgeLifecycleRouter",
      "contracts/bridge/BridgeGovernanceParameters.sol:BridgeGovernanceParameters",
      "contracts/bridge/BridgeGovernance.sol:BridgeGovernance",
      "contracts/frost-registry/libraries/FrostInactivity.sol:FrostInactivity",
      "contracts/frost-registry/FrostWalletRegistry.sol:FrostWalletRegistry",
    ]

    for (const artifactName of productionArtifacts) {
      // Link placeholders occupy the same 20 bytes as deployed addresses, so
      // string length is an exact runtime-size measurement before linking.
      // eslint-disable-next-line no-await-in-loop
      const artifact = await artifacts.readArtifact(artifactName)
      const runtimeBytes = (artifact.deployedBytecode.length - 2) / 2
      expect(runtimeBytes, artifactName).to.be.at.most(24_064)
    }
  })

  it("derives the exact positional inventory root, proofs, and migration calldata", () => {
    const manifest: CoverageInventoryDocument = {
      entries: [
        {
          index: 0,
          depositKey: "1",
          walletID: `0x${"11".repeat(32)}`,
          outputKey: `0x${"21".repeat(32)}`,
        },
        {
          index: 1,
          depositKey: "2",
          walletID: `0x${"12".repeat(32)}`,
          outputKey: `0x${"22".repeat(32)}`,
        },
      ],
    }
    const inventory = deriveCoverageInventory(manifest)
    expect(inventory.count).to.equal(2)
    expect(inventory.root).to.equal(
      utils.keccak256(utils.concat(inventory.entries.map(({ leaf }) => leaf)))
    )
    expect(inventory.entries[0].proof).to.deep.equal([
      inventory.entries[1].leaf,
    ])
    expect(inventory.entries[1].proof).to.deep.equal([
      inventory.entries[0].leaf,
    ])
    expect(inventory.entries[0].migrationPayload).to.match(/^0x[0-9a-f]+$/)
    expect(ACTIVATION_ARTIFACT_SCHEMA).to.equal(
      "tbtc/complete-p2tr-activation/v3"
    )

    expect(() =>
      deriveCoverageInventory({
        ...manifest,
        inventoryRoot: constants.HashZero,
      })
    ).to.throw("root does not match")
    expect(() =>
      deriveCoverageInventory({
        ...manifest,
        entries: [{ ...manifest.entries[0], index: 1 }],
      })
    ).to.throw("contiguous positional indices")
  })
})
