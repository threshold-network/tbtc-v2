import { expect } from "chai"
import { ethers, network } from "hardhat"
import type { providers } from "ethers"
import {
  assertCanonicalInventory,
  assertLegacyGovernanceReadyForHandoff,
  BRIDGE_LEGACY_FRAUD_STORAGE_LAYOUT_HASH,
  buildLegacyInventorySourcePreflight,
  HandoffManifest,
  InventoryBundle,
  LEGACY_GOVERNANCE_STORAGE_LAYOUT_HASH,
} from "../../scripts/ecdsa-fraud-router-cutover-lib"

async function expectRejected(
  promise: Promise<unknown>,
  message: string
): Promise<void> {
  try {
    await promise
    expect.fail(`expected rejection containing: ${message}`)
  } catch (error) {
    expect(String(error)).to.include(message)
  }
}

function storageWord(value: string | number): string {
  return ethers.utils.hexZeroPad(ethers.utils.hexlify(value), 32)
}

async function setStorage(
  address: string,
  slot: number,
  value: string | number
): Promise<void> {
  await network.provider.send("hardhat_setStorageAt", [
    address,
    ethers.utils.hexValue(slot),
    storageWord(value),
  ])
}

describe("ECDSA fraud cutover manifest guards", () => {
  function forwardedSubmissionProvider(traceAvailable: boolean): {
    provider: providers.Provider
    bridge: string
    expectedChallengeKey: string
  } {
    const bridge = "0x00000000000000000000000000000000000000b1"
    const forwarder = "0x00000000000000000000000000000000000000f1"
    const walletPublicKey =
      "0x989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9" +
      "d218b65e7d91c752f7b22eaceb771a9af3a6f3d3f010a5d471a1aeef7d7713af"
    const preimageSha256 = ethers.utils.hexZeroPad("0x1234", 32)
    const sighash = ethers.utils.sha256(preimageSha256)
    const signature = {
      v: 27,
      r: ethers.utils.hexZeroPad("0x01", 32),
      s: ethers.utils.hexZeroPad("0x02", 32),
    }
    const fraudInterface = new ethers.utils.Interface([
      "event FraudChallengeSubmitted(bytes20 indexed walletPubKeyHash,bytes32 sighash,uint8 v,bytes32 r,bytes32 s)",
      "function submitFraudChallenge(bytes walletPublicKey,bytes preimageSha256,(uint8 v,bytes32 r,bytes32 s) signature)",
    ])
    const calldata = fraudInterface.encodeFunctionData("submitFraudChallenge", [
      walletPublicKey,
      preimageSha256,
      signature,
    ])
    const walletPubKeyHash = ethers.utils.ripemd160(
      ethers.utils.sha256(
        ethers.utils.hexConcat([
          "0x03",
          ethers.utils.hexDataSlice(walletPublicKey, 0, 32),
        ])
      )
    )
    const encodedLog = fraudInterface.encodeEventLog(
      fraudInterface.getEvent("FraudChallengeSubmitted"),
      [walletPubKeyHash, sighash, signature.v, signature.r, signature.s]
    )
    const transactionHash = ethers.utils.hexZeroPad("0x42", 32)
    const blockHash = ethers.utils.hexZeroPad("0x99", 32)
    const provider = {
      getLogs: async () => [
        {
          address: bridge,
          blockHash,
          blockNumber: 100,
          data: encodedLog.data,
          logIndex: 0,
          removed: false,
          topics: encodedLog.topics,
          transactionHash,
          transactionIndex: 0,
        },
      ],
      getBlock: async () => ({ hash: blockHash }),
      getTransaction: async () => ({ to: forwarder, data: "0x" }),
      send: async () => {
        if (!traceAvailable) throw new Error("trace disabled")
        return {
          to: forwarder,
          input: "0x",
          calls: [{ to: bridge, input: calldata }],
        }
      },
    } as unknown as providers.Provider

    return {
      provider,
      bridge,
      expectedChallengeKey: ethers.BigNumber.from(
        ethers.utils.keccak256(
          ethers.utils.solidityPack(
            ["bytes", "bytes32"],
            [walletPublicKey, sighash]
          )
        )
      ).toString(),
    }
  }

  it("recovers forwarded legacy submissions from a unique Bridge call trace", async () => {
    const { provider, bridge, expectedChallengeKey } =
      forwardedSubmissionProvider(true)
    const preflight = await buildLegacyInventorySourcePreflight(
      provider,
      bridge,
      1,
      100
    )

    expect(preflight.sourceEventCount).to.equal(1)
    expect(preflight.challengeIdentityCount).to.equal(1)
    expect(preflight.challengeIdentityDigest).to.equal(
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["uint256[]"],
          [[expectedChallengeKey]]
        )
      )
    )
  })

  it("fails closed when forwarded submission traces are unavailable", async () => {
    const { provider, bridge } = forwardedSubmissionProvider(false)
    await expectRejected(
      buildLegacyInventorySourcePreflight(provider, bridge, 1, 100),
      "execution trace unavailable"
    )
  })

  it("detects hidden legacy governance parameter state by pinned slot", async () => {
    const [owner, bridge, replacement, reconciler] = await ethers.getSigners()
    const stubFactory = await ethers.getContractFactory(
      "LegacyEcdsaFraudRouterCutoverStub"
    )
    const oldGovernance = await stubFactory.deploy(bridge.address)
    await oldGovernance.deployed()
    const codeHash = ethers.utils.keccak256(
      await ethers.provider.getCode(oldGovernance.address)
    )
    const manifest: HandoffManifest = {
      version: 1,
      chainId: (await ethers.provider.getNetwork()).chainId,
      bridge: bridge.address,
      bridgeDeploymentBlock: 1,
      oldGovernance: oldGovernance.address,
      oldGovernanceRuntimeCodeHash: codeHash,
      oldGovernanceStorageLayoutHash: LEGACY_GOVERNANCE_STORAGE_LAYOUT_HASH,
      bridgeLegacyFraudStorageLayoutHash:
        BRIDGE_LEGACY_FRAUD_STORAGE_LAYOUT_HASH,
      newGovernance: replacement.address,
      newGovernanceRuntimeCodeHash: ethers.constants.HashZero,
      governanceOwner: owner.address,
      governanceDelay: "3600",
      oldRouter: owner.address,
      oldRouterRuntimeCodeHash: ethers.constants.HashZero,
      replacementRouter: replacement.address,
      replacementRouterRuntimeCodeHash: ethers.constants.HashZero,
      scanStartBlock: 1,
      legacyInventorySourcePreflight: {
        finalizedBlock: 1,
        finalizedBlockHash: ethers.constants.HashZero,
        sourceEventCount: 0,
        sourceEventDigest: ethers.constants.HashZero,
        challengeIdentityCount: 0,
        challengeIdentityDigest: ethers.constants.HashZero,
      },
      reconciler: reconciler.address,
      phase: "test",
    }

    await setStorage(oldGovernance.address, 0, owner.address)
    await setStorage(oldGovernance.address, 69, bridge.address)
    await setStorage(oldGovernance.address, 70, 3600)
    await assertLegacyGovernanceReadyForHandoff(ethers.provider, manifest)

    // Slot 2 is the first DepositData update timestamp. It has no public
    // getter on the historical wrapper and must not be inferred from events.
    await setStorage(oldGovernance.address, 2, 1234)
    await expectRejected(
      assertLegacyGovernanceReadyForHandoff(ethers.provider, manifest),
      "hidden pending parameter state in slot(s) 2"
    )
  })

  it("accepts only the signed replacement as an already-pending handoff", async () => {
    const [owner, bridge, replacement, other, reconciler] =
      await ethers.getSigners()
    const stubFactory = await ethers.getContractFactory(
      "LegacyEcdsaFraudRouterCutoverStub"
    )
    const oldGovernance = await stubFactory.deploy(bridge.address)
    await oldGovernance.deployed()
    const manifest: HandoffManifest = {
      version: 1,
      chainId: (await ethers.provider.getNetwork()).chainId,
      bridge: bridge.address,
      bridgeDeploymentBlock: 1,
      oldGovernance: oldGovernance.address,
      oldGovernanceRuntimeCodeHash: ethers.utils.keccak256(
        await ethers.provider.getCode(oldGovernance.address)
      ),
      oldGovernanceStorageLayoutHash: LEGACY_GOVERNANCE_STORAGE_LAYOUT_HASH,
      bridgeLegacyFraudStorageLayoutHash:
        BRIDGE_LEGACY_FRAUD_STORAGE_LAYOUT_HASH,
      newGovernance: replacement.address,
      newGovernanceRuntimeCodeHash: ethers.constants.HashZero,
      governanceOwner: owner.address,
      governanceDelay: "3600",
      oldRouter: owner.address,
      oldRouterRuntimeCodeHash: ethers.constants.HashZero,
      replacementRouter: replacement.address,
      replacementRouterRuntimeCodeHash: ethers.constants.HashZero,
      scanStartBlock: 1,
      legacyInventorySourcePreflight: {
        finalizedBlock: 1,
        finalizedBlockHash: ethers.constants.HashZero,
        sourceEventCount: 0,
        sourceEventDigest: ethers.constants.HashZero,
        challengeIdentityCount: 0,
        challengeIdentityDigest: ethers.constants.HashZero,
      },
      reconciler: reconciler.address,
      phase: "test",
    }
    await setStorage(oldGovernance.address, 0, owner.address)
    await setStorage(oldGovernance.address, 69, bridge.address)
    await setStorage(oldGovernance.address, 70, 3600)
    await setStorage(oldGovernance.address, 73, 1234)
    await setStorage(oldGovernance.address, 74, replacement.address)

    await assertLegacyGovernanceReadyForHandoff(
      ethers.provider,
      manifest,
      replacement.address
    )
    await expectRejected(
      assertLegacyGovernanceReadyForHandoff(
        ethers.provider,
        manifest,
        other.address
      ),
      "pending transfer mismatch"
    )
  })

  it("rejects a truncated canonical inventory range", () => {
    const manifest = {
      scanStartBlock: 100,
      bridgeDeploymentBlock: 100,
    } as HandoffManifest
    const inventory = {
      scanStartBlock: 101,
      scanEndBlock: 200,
      finalizedBlock: 200,
      finalizedBlockHash: ethers.constants.HashZero,
      challengeKeys: [],
      challenges: [],
      challengeSetHash: ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          [
            "uint256[]",
            "tuple(address challenger,uint256 depositAmount,uint32 reportedAt,bool resolved)[]",
          ],
          [[], []]
        )
      ),
      challengeCount: 0,
      totalEscrow: "0",
      oldRouterOpenChallengeCount: "0",
      bridgeLegacyEscrowBalance: "0",
      sourceEventCount: 0,
      sourceEventDigest: ethers.constants.HashZero,
    } as InventoryBundle

    expect(() => assertCanonicalInventory(manifest, inventory)).to.throw(
      "truncated inventory scan"
    )
  })
})
