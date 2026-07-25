/* eslint-disable no-param-reassign */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { expect } from "chai"
import { Wallet } from "ethers"
import { ethers } from "hardhat"
import { scanCanonicalHistory } from "../../scripts/frost-wallet-registry-canonical-history"

import {
  ARCHIVE_MANIFEST_COMMIT_TUPLE,
  ARCHIVE_MANIFEST_SCHEMA_HASH,
  ARCHIVE_MIGRATION_START_TUPLE,
  ARCHIVE_RECONCILER_ATTESTATION_ROLE,
  ARCHIVE_SOURCE_ATTESTATION_ROLE,
  ARCHIVE_START_SCHEMA_HASH,
  ArchiveManifestEntry,
  ArchiveManifestV2,
  buildArchiveManifestAttestation,
  buildArchiveMerkleTree,
  hashArchiveManifestV2,
  hashArchiveManifestAttestation,
  hashArchiveCheckpointAttestation,
  hashArchiveMigrationStart,
} from "../../deploy/54_upgrade_frost_wallet_registry_archive"

describe("FROST archive migration security", () => {
  const ADMIN_SLOT =
    "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
  const legacyWalletA = `0x${"11".repeat(32)}`
  const legacyWalletB = `0x${"22".repeat(32)}`
  const postUpgradeWallet = `0x${"33".repeat(32)}`
  const membersA = ethers.utils.id("archive-members-a")
  const membersB = ethers.utils.id("archive-members-b")
  const postUpgradeMembers = ethers.utils.id("archive-members-post-upgrade")

  const signDigest = (wallet: Wallet, digest: string): string =>
    ethers.utils.joinSignature(wallet._signingKey().signDigest(digest))

  const encodeCommit = (
    signed: any,
    authoritySignature = signed.signature,
    sourceSignature = signed.sourceSignature,
    reconcilerSignature = signed.reconcilerSignature
  ): string =>
    ethers.utils.defaultAbiCoder.encode(
      [ARCHIVE_MANIFEST_COMMIT_TUPLE],
      [
        {
          manifest: signed.manifest,
          authoritySignature,
          sourceSignature,
          reconcilerSignature,
        },
      ]
    )

  const startPayload = (
    base: any,
    authoritySignature: string,
    authority = base.authority,
    sourceSignature = signDigest(
      base.sourceAttesterSigner,
      base.sourceAttestationHash
    ),
    reconcilerSignature = signDigest(
      base.reconcilerAttesterSigner,
      base.reconcilerAttestationHash
    )
  ) => ({
    authority,
    oldImplementation: base.v1.address,
    checkpointHash: base.checkpointHash,
    scanFromBlock: base.scanFromBlock,
    checkpointBlockNumber: base.checkpointBlockNumber,
    checkpointBlockHash: base.checkpointBlockHash,
    historyCommitment: base.historyCommitment,
    inventoryRoot: base.inventoryRoot,
    inventoryCount: base.inventoryCount,
    maxTailBlocks: base.maxTailBlocks,
    upgradeDeadlineBlock: base.upgradeDeadlineBlock,
    sourceAttestation: {
      attester: base.sourceAttestation.attester,
      sourceIdentityHash: base.sourceAttestation.sourceIdentityHash,
      endpointIdentityHash: base.sourceAttestation.endpointIdentityHash,
      trustDomainHash: base.sourceAttestation.trustDomainHash,
      endpointPolicyHash: base.sourceAttestation.endpointPolicyHash,
      signature: sourceSignature,
    },
    reconcilerAttestation: {
      attester: base.reconcilerAttestation.attester,
      sourceIdentityHash: base.reconcilerAttestation.sourceIdentityHash,
      endpointIdentityHash: base.reconcilerAttestation.endpointIdentityHash,
      trustDomainHash: base.reconcilerAttestation.trustDomainHash,
      endpointPolicyHash: base.reconcilerAttestation.endpointPolicyHash,
      signature: reconcilerSignature,
    },
    authoritySignature,
  })

  const encodeStart = (
    base: any,
    authoritySignature: string,
    authority = base.authority,
    sourceSignature?: string,
    reconcilerSignature?: string
  ): string =>
    ethers.utils.defaultAbiCoder.encode(
      [ARCHIVE_MIGRATION_START_TUPLE],
      [
        startPayload(
          base,
          authoritySignature,
          authority,
          sourceSignature,
          reconcilerSignature
        ),
      ]
    )

  async function deployBase(
    authorityKind: "eoa" | "eip1271" = "eoa",
    closeLegacyWallets = true
  ) {
    const [proxyAdminOwner, governance, outsider] = await ethers.getSigners()
    const authoritySigner = Wallet.createRandom()
    const sourceAttesterSigner = Wallet.createRandom()
    const reconcilerAttesterSigner = Wallet.createRandom()

    const inactivityFactory = await ethers.getContractFactory("FrostInactivity")
    const inactivity = await inactivityFactory.deploy()
    await inactivity.deployed()

    const v1Factory = await ethers.getContractFactory(
      "FrostArchiveMigrationHarnessV1"
    )
    const v1 = await v1Factory.deploy()
    await v1.deployed()

    const proxyAdminFactory = await ethers.getContractFactory("ProxyAdmin")
    const proxyAdmin = await proxyAdminFactory.connect(proxyAdminOwner).deploy()
    await proxyAdmin.deployed()

    const proxyFactory = await ethers.getContractFactory(
      "TransparentUpgradeableProxy"
    )
    const initialize = v1Factory.interface.encodeFunctionData("initialize", [
      governance.address,
    ])
    const proxy = await proxyFactory.deploy(
      v1.address,
      proxyAdmin.address,
      initialize
    )
    await proxy.deployed()
    const proxyReceipt = await proxy.deployTransaction.wait()
    const proxyV1 = v1Factory.attach(proxy.address)

    await proxyV1.addWallet(legacyWalletA, membersA)
    await proxyV1.addWallet(legacyWalletB, membersB)
    await proxyV1.addWallet(postUpgradeWallet, postUpgradeMembers)
    if (closeLegacyWallets) {
      await proxyV1.legacyCloseWallet(legacyWalletA)
      await proxyV1.legacyCloseWallet(legacyWalletB)
    }

    const v2Factory = await ethers.getContractFactory(
      "FrostArchiveMigrationHarnessV2",
      { libraries: { FrostInactivity: inactivity.address } }
    )
    const v2 = await v2Factory.deploy()
    await v2.deployed()
    const proxyV2 = v2Factory.attach(proxy.address)

    let authority = authoritySigner.address
    let authorityContract: any
    if (authorityKind === "eip1271") {
      const authorityFactory = await ethers.getContractFactory(
        "ArchiveManifestAuthorityStub"
      )
      authorityContract = await authorityFactory.deploy(authoritySigner.address)
      await authorityContract.deployed()
      authority = authorityContract.address
    }

    const chainId = (await ethers.provider.getNetwork()).chainId.toString()
    const oldImplementationCodeHash = ethers.utils.keccak256(
      await ethers.provider.getCode(v1.address)
    )
    const newImplementationCodeHash = ethers.utils.keccak256(
      await ethers.provider.getCode(v2.address)
    )
    const checkpointHash = ethers.utils.id("archive-test-checkpoint")
    const checkpointBlockNumber = await ethers.provider.getBlockNumber()
    const checkpointBlock = await ethers.provider.getBlock(
      checkpointBlockNumber
    )
    const checkpointBlockHash = checkpointBlock.hash
    const maxTailBlocks = 64
    const upgradeDeadlineBlock = checkpointBlockNumber + maxTailBlocks
    const scanFromBlock = proxyReceipt.blockNumber
    const historyCommitment = ethers.utils.id("archive-history-commitment")
    const inventory = buildArchiveMerkleTree(entries())
    const inventoryRoot = inventory.root
    const inventoryCount = inventory.entries.length
    const attestationCommon = {
      chainId,
      registry: proxy.address,
      checkpointHash,
      scanFromBlock,
      checkpointBlockNumber,
      checkpointBlockHash,
      historyCommitment,
      inventoryRoot,
      inventoryCount,
      maxTailBlocks,
      upgradeDeadlineBlock,
      schemaHash: ethers.utils.id(
        "tbtc/frost-wallet-archive/checkpoint-attestation-v1"
      ),
    }
    const sourceAttestation = {
      ...attestationCommon,
      role: ARCHIVE_SOURCE_ATTESTATION_ROLE,
      attester: sourceAttesterSigner.address,
      sourceIdentityHash: ethers.utils.id("source-provider-identity"),
      endpointIdentityHash: ethers.utils.id("source-tls-spki"),
      trustDomainHash: ethers.utils.id("source-trust-domain"),
      endpointPolicyHash: ethers.utils.id("source-endpoint-policy"),
    }
    const reconcilerAttestation = {
      ...attestationCommon,
      role: ARCHIVE_RECONCILER_ATTESTATION_ROLE,
      attester: reconcilerAttesterSigner.address,
      sourceIdentityHash: ethers.utils.id("reconciler-provider-identity"),
      endpointIdentityHash: ethers.utils.id("reconciler-tls-spki"),
      trustDomainHash: ethers.utils.id("reconciler-trust-domain"),
      endpointPolicyHash: ethers.utils.id("reconciler-endpoint-policy"),
    }
    const sourceAttestationHash =
      hashArchiveCheckpointAttestation(sourceAttestation)
    const reconcilerAttestationHash = hashArchiveCheckpointAttestation(
      reconcilerAttestation
    )
    const startAuthorization = {
      chainId,
      registry: proxy.address,
      oldImplementationCodeHash,
      newImplementationCodeHash,
      authority,
      checkpointHash,
      checkpointBlockNumber,
      maxTailBlocks,
      upgradeDeadlineBlock,
      sourceAttester: sourceAttesterSigner.address,
      sourceAttestationHash,
      reconcilerAttester: reconcilerAttesterSigner.address,
      reconcilerAttestationHash,
      schemaHash: ARCHIVE_START_SCHEMA_HASH,
    }

    return {
      proxyAdminOwner,
      governance,
      outsider,
      authority,
      authoritySigner,
      sourceAttesterSigner,
      reconcilerAttesterSigner,
      authorityContract,
      inactivity,
      v1,
      v2,
      proxy,
      proxyAdmin,
      proxyV1,
      proxyV2,
      v1Factory,
      v2Factory,
      chainId,
      oldImplementationCodeHash,
      newImplementationCodeHash,
      checkpointHash,
      scanFromBlock,
      checkpointBlockNumber,
      checkpointBlockHash,
      historyCommitment,
      inventoryRoot,
      inventoryCount,
      maxTailBlocks,
      upgradeDeadlineBlock,
      sourceAttestation,
      reconcilerAttestation,
      sourceAttestationHash,
      reconcilerAttestationHash,
      startAuthorization,
    }
  }

  function refreshAttestationBindings(base: any): void {
    base.upgradeDeadlineBlock = base.checkpointBlockNumber + base.maxTailBlocks
    const common = {
      chainId: base.chainId,
      registry: base.proxy.address,
      checkpointHash: base.checkpointHash,
      scanFromBlock: base.scanFromBlock,
      checkpointBlockNumber: base.checkpointBlockNumber,
      checkpointBlockHash: base.checkpointBlockHash,
      historyCommitment: base.historyCommitment,
      inventoryRoot: base.inventoryRoot,
      inventoryCount: base.inventoryCount,
      maxTailBlocks: base.maxTailBlocks,
      upgradeDeadlineBlock: base.upgradeDeadlineBlock,
    }
    base.sourceAttestation = { ...base.sourceAttestation, ...common }
    base.reconcilerAttestation = { ...base.reconcilerAttestation, ...common }
    base.sourceAttestationHash = hashArchiveCheckpointAttestation(
      base.sourceAttestation
    )
    base.reconcilerAttestationHash = hashArchiveCheckpointAttestation(
      base.reconcilerAttestation
    )
    base.startAuthorization = {
      ...base.startAuthorization,
      checkpointHash: base.checkpointHash,
      checkpointBlockNumber: base.checkpointBlockNumber,
      maxTailBlocks: base.maxTailBlocks,
      upgradeDeadlineBlock: base.upgradeDeadlineBlock,
      sourceAttester: base.sourceAttestation.attester,
      sourceAttestationHash: base.sourceAttestationHash,
      sourceIdentityHash: base.sourceAttestation.sourceIdentityHash,
      sourceEndpointIdentityHash: base.sourceAttestation.endpointIdentityHash,
      sourceTrustDomainHash: base.sourceAttestation.trustDomainHash,
      sourceEndpointPolicyHash: base.sourceAttestation.endpointPolicyHash,
      reconcilerAttester: base.reconcilerAttestation.attester,
      reconcilerAttestationHash: base.reconcilerAttestationHash,
      reconcilerIdentityHash: base.reconcilerAttestation.sourceIdentityHash,
      reconcilerEndpointIdentityHash:
        base.reconcilerAttestation.endpointIdentityHash,
      reconcilerTrustDomainHash: base.reconcilerAttestation.trustDomainHash,
      reconcilerEndpointPolicyHash:
        base.reconcilerAttestation.endpointPolicyHash,
    }
  }

  async function upgrade(
    base: any,
    signature?: string,
    sourceSignature?: string,
    reconcilerSignature?: string
  ) {
    const digest = hashArchiveMigrationStart(base.startAuthorization)
    const authorizationSignature =
      signature ?? signDigest(base.authoritySigner, digest)
    const initializer = base.v2Factory.interface.encodeFunctionData(
      "beginArchiveMigration",
      [
        encodeStart(
          base,
          authorizationSignature,
          base.authority,
          sourceSignature,
          reconcilerSignature
        ),
      ]
    )
    const receipt = await (
      await base.proxyAdmin
        .connect(base.proxyAdminOwner)
        .upgradeAndCall(base.proxy.address, base.v2.address, initializer)
    ).wait()
    return { digest, receipt }
  }

  function entries(): ArchiveManifestEntry[] {
    return [
      {
        walletID: legacyWalletA,
        dkgResultHash: ethers.utils.id("archive-dkg-a"),
        membersIdsHash: membersA,
      },
      {
        walletID: legacyWalletB,
        dkgResultHash: ethers.utils.id("archive-dkg-b"),
        membersIdsHash: membersB,
      },
    ]
  }

  async function manifestFor(base: any, upgradeReceipt: any, count = 2) {
    const selectedEntries = entries().slice(0, count)
    const merkle = buildArchiveMerkleTree(selectedEntries)
    const upgradeBlock = await ethers.provider.getBlock(
      upgradeReceipt.blockNumber
    )
    const proxyReceipt = await base.proxy.deployTransaction.wait()
    const manifest: ArchiveManifestV2 = {
      chainId: base.chainId,
      registry: base.proxy.address,
      oldImplementationCodeHash: base.oldImplementationCodeHash,
      newImplementationCodeHash: base.newImplementationCodeHash,
      checkpointHash: base.checkpointHash,
      checkpointBlockNumber: base.checkpointBlockNumber,
      maxTailBlocks: base.maxTailBlocks,
      upgradeDeadlineBlock: base.upgradeDeadlineBlock,
      sourceAttester: base.sourceAttestation.attester,
      sourceAttestationHash: base.sourceAttestationHash,
      sourceIdentityHash: base.sourceAttestation.sourceIdentityHash,
      sourceEndpointIdentityHash: base.sourceAttestation.endpointIdentityHash,
      sourceTrustDomainHash: base.sourceAttestation.trustDomainHash,
      sourceEndpointPolicyHash: base.sourceAttestation.endpointPolicyHash,
      reconcilerAttester: base.reconcilerAttestation.attester,
      reconcilerAttestationHash: base.reconcilerAttestationHash,
      reconcilerIdentityHash: base.reconcilerAttestation.sourceIdentityHash,
      reconcilerEndpointIdentityHash:
        base.reconcilerAttestation.endpointIdentityHash,
      reconcilerTrustDomainHash: base.reconcilerAttestation.trustDomainHash,
      reconcilerEndpointPolicyHash:
        base.reconcilerAttestation.endpointPolicyHash,
      upgradeBlockNumber: upgradeReceipt.blockNumber,
      upgradeBlockHash: upgradeBlock.hash,
      upgradeTransactionIndex: upgradeReceipt.transactionIndex,
      scanFromBlock: proxyReceipt.blockNumber,
      scanToBlock: upgradeReceipt.blockNumber,
      historyRoot: ethers.utils.id("authenticated-canonical-history"),
      walletsRoot: merkle.root,
      walletCount: merkle.entries.length,
      schemaHash: ARCHIVE_MANIFEST_SCHEMA_HASH,
    }
    const digest = hashArchiveManifestV2(manifest)
    const sourceAttestation = buildArchiveManifestAttestation(
      manifest,
      digest,
      ARCHIVE_SOURCE_ATTESTATION_ROLE,
      manifest.sourceAttester
    )
    const reconcilerAttestation = buildArchiveManifestAttestation(
      manifest,
      digest,
      ARCHIVE_RECONCILER_ATTESTATION_ROLE,
      manifest.reconcilerAttester
    )
    const sourceAttestationHash =
      hashArchiveManifestAttestation(sourceAttestation)
    const reconcilerAttestationHash = hashArchiveManifestAttestation(
      reconcilerAttestation
    )
    return {
      manifest,
      digest,
      signature: signDigest(base.authoritySigner, digest),
      sourceAttestation,
      reconcilerAttestation,
      sourceAttestationHash,
      reconcilerAttestationHash,
      sourceSignature: signDigest(
        base.sourceAttesterSigner,
        sourceAttestationHash
      ),
      reconcilerSignature: signDigest(
        base.reconcilerAttesterSigner,
        reconcilerAttestationHash
      ),
      proofs: merkle.entries,
    }
  }

  it("requires an exact, independent phase-start authorization", async () => {
    const base = await deployBase()
    const wrongChainAuthorization = {
      ...base.startAuthorization,
      chainId: (Number(base.chainId) + 1).toString(),
    }
    const wrongChainSignature = signDigest(
      base.authoritySigner,
      hashArchiveMigrationStart(wrongChainAuthorization)
    )
    await expect(upgrade(base, wrongChainSignature)).to.be.reverted
    expect(
      await base.proxyAdmin.getProxyImplementation(base.proxy.address)
    ).to.equal(base.v1.address)

    const wrongSigner = Wallet.createRandom()
    const digest = hashArchiveMigrationStart(base.startAuthorization)
    await expect(upgrade(base, signDigest(wrongSigner, digest))).to.be.reverted

    const { checkpointHash } = base
    base.checkpointHash = ethers.utils.id("altered-checkpoint")
    await expect(upgrade(base, signDigest(base.authoritySigner, digest))).to.be
      .reverted
    base.checkpointHash = checkpointHash

    const governanceInitializer = base.v2Factory.interface.encodeFunctionData(
      "beginArchiveMigration",
      [encodeStart(base, "0x", base.governance.address)]
    )
    await expect(
      base.proxyAdmin
        .connect(base.proxyAdminOwner)
        .upgradeAndCall(
          base.proxy.address,
          base.v2.address,
          governanceInitializer
        )
    ).to.be.reverted

    await upgrade(base)
    const state = await base.proxyV2.getMigration()
    expect(state.state).to.equal(1)
    expect(state.authority).to.equal(base.authority)

    const adminWord = await ethers.provider.getStorageAt(
      base.proxy.address,
      ADMIN_SLOT
    )
    expect(ethers.utils.getAddress(`0x${adminWord.slice(-40)}`)).to.equal(
      base.proxyAdmin.address
    )
    await expect(
      base.proxyV2
        .connect(base.outsider)
        .beginArchiveMigration(
          encodeStart(base, signDigest(base.authoritySigner, digest))
        )
    ).to.be.reverted
  })

  it("domain-binds phase authorization to the proxy and code hashes", async () => {
    const base = await deployBase()
    const proxyFactory = await ethers.getContractFactory(
      "TransparentUpgradeableProxy"
    )
    const initialize = base.v1Factory.interface.encodeFunctionData(
      "initialize",
      [base.governance.address]
    )
    const secondProxy = await proxyFactory.deploy(
      base.v1.address,
      base.proxyAdmin.address,
      initialize
    )
    await secondProxy.deployed()
    const firstProxyDigest = hashArchiveMigrationStart(base.startAuthorization)
    const replayedInitializer = base.v2Factory.interface.encodeFunctionData(
      "beginArchiveMigration",
      [encodeStart(base, signDigest(base.authoritySigner, firstProxyDigest))]
    )
    await expect(
      base.proxyAdmin
        .connect(base.proxyAdminOwner)
        .upgradeAndCall(
          secondProxy.address,
          base.v2.address,
          replayedInitializer
        )
    ).to.be.reverted
    expect(
      await base.proxyAdmin.getProxyImplementation(secondProxy.address)
    ).to.equal(base.v1.address)
  })

  it("uses exact transaction ordering for closes in the upgrade block", async () => {
    const base = await deployBase("eoa", false)
    const digest = hashArchiveMigrationStart(base.startAuthorization)
    const initializer = base.v2Factory.interface.encodeFunctionData(
      "beginArchiveMigration",
      [encodeStart(base, signDigest(base.authoritySigner, digest))]
    )

    await ethers.provider.send("evm_setAutomine", [false])
    let beforeTransaction: any
    let upgradeTransaction: any
    let afterTransaction: any
    try {
      beforeTransaction = await base.proxyV1
        .connect(base.proxyAdminOwner)
        .legacyCloseWallet(legacyWalletA, { gasLimit: 1_000_000 })
      upgradeTransaction = await base.proxyAdmin
        .connect(base.proxyAdminOwner)
        .upgradeAndCall(base.proxy.address, base.v2.address, initializer, {
          gasLimit: 3_000_000,
        })
      afterTransaction = await base.proxyV2
        .connect(base.proxyAdminOwner)
        .closeWallet(legacyWalletB, { gasLimit: 1_000_000 })
      await ethers.provider.send("evm_mine", [])
    } finally {
      await ethers.provider.send("evm_setAutomine", [true])
    }

    const beforeReceipt = await beforeTransaction.wait()
    const upgradeReceipt = await upgradeTransaction.wait()
    const afterReceipt = await afterTransaction.wait()
    expect(beforeReceipt.blockNumber).to.equal(upgradeReceipt.blockNumber)
    expect(afterReceipt.blockNumber).to.equal(upgradeReceipt.blockNumber)
    expect(beforeReceipt.transactionIndex).to.be.lessThan(
      upgradeReceipt.transactionIndex
    )
    expect(afterReceipt.transactionIndex).to.be.greaterThan(
      upgradeReceipt.transactionIndex
    )

    const walletClosedTopic = ethers.utils.id("WalletClosed(bytes32)")
    const canonical = await scanCanonicalHistory(
      ethers.provider,
      base.proxy.address,
      upgradeReceipt.blockNumber,
      upgradeReceipt.blockNumber,
      [walletClosedTopic],
      {
        blockNumber: upgradeReceipt.blockNumber,
        transactionIndex: upgradeReceipt.transactionIndex,
        logIndex: 0,
      }
    )
    expect(canonical.evidence.selectedLogCount).to.equal(1)
    expect(canonical.selectedLogs[0].topics[1]).to.equal(legacyWalletA)
    expect(
      await base.proxyV2.getRetainedWalletMembersIdsHash(legacyWalletB)
    ).to.equal(membersB)
    await expect(base.proxyV2.getRetainedWalletMembersIdsHash(legacyWalletA)).to
      .be.reverted
  })

  it("supports a pinned EIP-1271 authority and fails closed on rejection", async () => {
    const base = await deployBase("eip1271")
    await base.authorityContract.setRejectSignatures(true)
    await expect(upgrade(base)).to.be.reverted
    await base.authorityContract.setRejectSignatures(false)
    await upgrade(base)
    expect((await base.proxyV2.getMigration()).authority).to.equal(
      base.authorityContract.address
    )
  })

  it("supports EIP-1271 checkpoint attesters and rejects swapped roles", async () => {
    const base = await deployBase()
    const attesterFactory = await ethers.getContractFactory(
      "ArchiveManifestAuthorityStub"
    )
    const reconcilerContract = await attesterFactory.deploy(
      base.reconcilerAttesterSigner.address
    )
    await reconcilerContract.deployed()
    base.reconcilerAttestation.attester = reconcilerContract.address
    refreshAttestationBindings(base)
    const { receipt } = await upgrade(base)
    expect((await base.proxyV2.getAttestations()).reconcilerAttester).to.equal(
      reconcilerContract.address
    )
    const signedManifest = await manifestFor(base, receipt, 0)
    await base.proxyV2
      .connect(base.governance)
      .commitArchiveMigrationManifest(encodeCommit(signedManifest))
    expect(
      (await base.proxyV2.getFinalAttestations()).reconcilerAttestationHash
    ).to.equal(signedManifest.reconcilerAttestationHash)

    const swapped = await deployBase()
    const sourceSignature = signDigest(
      swapped.sourceAttesterSigner,
      swapped.sourceAttestationHash
    )
    const reconcilerSignature = signDigest(
      swapped.reconcilerAttesterSigner,
      swapped.reconcilerAttestationHash
    )
    await expect(
      upgrade(swapped, undefined, reconcilerSignature, sourceSignature)
    ).to.be.reverted
  })

  it("rejects aliased backends and tails above the hard cap", async () => {
    const aliased = await deployBase()
    aliased.reconcilerAttestation.endpointIdentityHash =
      aliased.sourceAttestation.endpointIdentityHash
    refreshAttestationBindings(aliased)
    await expect(upgrade(aliased)).to.be.reverted

    const oversized = await deployBase()
    oversized.maxTailBlocks = 65
    refreshAttestationBindings(oversized)
    await expect(upgrade(oversized)).to.be.reverted
  })

  it("allows the atomic upgrade at the exact signed deadline", async () => {
    const base = await deployBase()
    base.maxTailBlocks = 1
    refreshAttestationBindings(base)
    await upgrade(base)
    expect(
      (await base.proxyV2.getAttestations()).upgradeDeadlineBlock
    ).to.equal(base.upgradeDeadlineBlock)
  })

  it("fails the atomic upgrade once the signed tail bound expires", async () => {
    const base = await deployBase()
    base.maxTailBlocks = 1
    refreshAttestationBindings(base)
    await ethers.provider.send("hardhat_mine", ["0x1"])
    await expect(upgrade(base)).to.be.reverted
    expect(
      await base.proxyAdmin.getProxyImplementation(base.proxy.address)
    ).to.equal(base.v1.address)
  })

  it("requires both role-separated attestations over the exact final tail", async () => {
    const base = await deployBase()
    const { receipt } = await upgrade(base)
    const signed = await manifestFor(base, receipt)

    await expect(
      base.proxyV2
        .connect(base.governance)
        .commitArchiveMigrationManifest(
          encodeCommit(signed, signed.signature, signed.sourceSignature, "0x")
        )
    ).to.be.reverted
    await expect(
      base.proxyV2
        .connect(base.governance)
        .commitArchiveMigrationManifest(
          encodeCommit(
            signed,
            signed.signature,
            signed.reconcilerSignature,
            signed.sourceSignature
          )
        )
    ).to.be.reverted

    const omitted = await manifestFor(base, receipt, 1)
    await expect(
      base.proxyV2
        .connect(base.governance)
        .commitArchiveMigrationManifest(
          encodeCommit(
            omitted,
            omitted.signature,
            signed.sourceSignature,
            signed.reconcilerSignature
          )
        )
    ).to.be.reverted

    await base.proxyV2
      .connect(base.governance)
      .commitArchiveMigrationManifest(encodeCommit(signed))
    const finalAttestations = await base.proxyV2.getFinalAttestations()
    expect(finalAttestations.sourceAttestationHash).to.equal(
      signed.sourceAttestationHash
    )
    expect(finalAttestations.reconcilerAttestationHash).to.equal(
      signed.reconcilerAttestationHash
    )
  })

  it("backfills indexed Merkle proofs exactly once and finalizes exactly", async () => {
    const base = await deployBase()
    const { receipt } = await upgrade(base)

    // A wallet closed after the atomic upgrade already tombstones normally and
    // must not be part of the legacy-loss proof set.
    await base.proxyV2.closeWallet(postUpgradeWallet)
    expect(
      await base.proxyV2.getRetainedWalletMembersIdsHash(postUpgradeWallet)
    ).to.equal(postUpgradeMembers)

    const signed = await manifestFor(base, receipt)
    const wrongSignature = signDigest(Wallet.createRandom(), signed.digest)
    await expect(
      base.proxyV2
        .connect(base.governance)
        .commitArchiveMigrationManifest(encodeCommit(signed, wrongSignature))
    ).to.be.reverted
    await expect(
      base.proxyV2
        .connect(base.outsider)
        .commitArchiveMigrationManifest(encodeCommit(signed))
    ).to.be.revertedWith("Caller is not the governance")

    const alteredCheckpointManifest = {
      ...signed.manifest,
      checkpointHash: ethers.utils.id("altered-final-checkpoint"),
    }
    const alteredCheckpointDigest = hashArchiveManifestV2(
      alteredCheckpointManifest
    )
    await expect(
      base.proxyV2
        .connect(base.governance)
        .commitArchiveMigrationManifest(
          encodeCommit(
            { ...signed, manifest: alteredCheckpointManifest },
            signDigest(base.authoritySigner, alteredCheckpointDigest)
          )
        )
    ).to.be.reverted

    await base.proxyV2
      .connect(base.governance)
      .commitArchiveMigrationManifest(encodeCommit(signed))
    expect((await base.proxyV2.getMigration()).state).to.equal(2)
    await expect(base.proxyV2.finalizeArchiveMigration()).to.be.reverted

    const first = signed.proofs[0]
    const second = signed.proofs[1]
    await expect(
      base.proxyV2.backfillArchivedWalletMembership(
        second.index,
        first.walletID,
        first.dkgResultHash,
        first.membersIdsHash,
        second.proof
      )
    ).to.be.reverted
    await base.proxyV2.backfillArchivedWalletMembership(
      first.index,
      first.walletID,
      first.dkgResultHash,
      first.membersIdsHash,
      first.proof
    )
    await expect(
      base.proxyV2.backfillArchivedWalletMembership(
        first.index,
        first.walletID,
        first.dkgResultHash,
        first.membersIdsHash,
        first.proof
      )
    ).to.be.reverted
    await base.proxyV2.backfillArchivedWalletMembership(
      second.index,
      second.walletID,
      second.dkgResultHash,
      second.membersIdsHash,
      second.proof
    )

    const beforeFinalization = await base.proxyV2.getMigration()
    expect(beforeFinalization.completed).to.equal(2)
    expect(beforeFinalization.expected).to.equal(2)
    await base.proxyV2.finalizeArchiveMigration()
    const completed = await base.proxyV2.getMigration()
    expect(completed.state).to.equal(3)
    expect(completed.manifestHash).to.equal(signed.digest)
    expect(
      await base.proxyV2.getRetainedWalletMembersIdsHash(legacyWalletA)
    ).to.equal(membersA)
    expect(
      await base.proxyV2.getRetainedWalletMembersIdsHash(legacyWalletB)
    ).to.equal(membersB)
  })

  it("allows an authenticated empty migration to complete", async () => {
    const base = await deployBase()
    const { receipt } = await upgrade(base)
    const signed = await manifestFor(base, receipt, 0)
    expect(signed.manifest.walletsRoot).to.equal(ethers.constants.HashZero)
    await base.proxyV2
      .connect(base.governance)
      .commitArchiveMigrationManifest(encodeCommit(signed))
    await base.proxyV2.finalizeArchiveMigration()
    expect((await base.proxyV2.getMigration()).state).to.equal(3)
  })
})
