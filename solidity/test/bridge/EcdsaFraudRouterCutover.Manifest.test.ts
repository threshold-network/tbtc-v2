import { expect } from "chai"
import { ethers, network } from "hardhat"
import type { providers } from "ethers"
import type {
  EcdsaFraudRouter,
  RevertingEcdsaFraudChallenger,
} from "../../typechain"
import { constants } from "../fixtures"
import {
  nonWitnessSignSingleInputTx,
  wallet as fraudWallet,
} from "../data/fraud"
import {
  assertCanonicalInventory,
  assertLegacyGovernanceReadyForHandoff,
  BRIDGE_LEGACY_FRAUD_STORAGE_LAYOUT_HASH,
  buildLegacyInventorySourcePreflight,
  HandoffManifest,
  HistoryEmitter,
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
  // `hardhat_setStorageAt` leaves the write pending, and smock caches the
  // state manager it installs fake bytecode through. Until a block is mined
  // that cache is stale and every later `smock.fake()` in the process
  // silently installs no code.
  await network.provider.send("evm_mine")
}

describe("ECDSA fraud cutover manifest guards", () => {
  function hardhatCanonicalTraceProvider(): providers.Provider & {
    send(method: string, params: unknown[]): Promise<unknown>
  } {
    const { provider } = ethers
    return new Proxy(provider, {
      get(target, property, receiver) {
        if (property === "send") {
          return async (method: string, params: unknown[]) => {
            if (method !== "debug_traceBlockByHash") {
              return target.send(method, params)
            }
            const block = (await target.send("eth_getBlockByHash", [
              params[0],
              true,
            ])) as {
              transactions: Array<{
                hash: string
                from: string
                to: string
                input: string
                value: string
              }>
            }
            return Promise.all(
              block.transactions.map(async (transaction) => {
                const trace = (await target.send("debug_traceTransaction", [
                  transaction.hash,
                  params[1],
                ])) as {
                  failed: boolean
                  structLogs?: Array<{
                    op: string
                    depth: number
                    stack: string[]
                    memory: string[]
                  }>
                }
                const calls = (trace.structLogs ?? [])
                  .filter(({ op, depth }) => op === "CALL" && depth === 1)
                  .map(({ stack, memory }) => {
                    const value = ethers.BigNumber.from(
                      `0x${stack[stack.length - 3]}`
                    )
                    const inputOffset = ethers.BigNumber.from(
                      `0x${stack[stack.length - 4]}`
                    ).toNumber()
                    const inputSize = ethers.BigNumber.from(
                      `0x${stack[stack.length - 5]}`
                    ).toNumber()
                    const memoryBytes = `0x${memory.join("")}`
                    return {
                      from: transaction.to,
                      to: ethers.utils.getAddress(
                        ethers.utils.hexDataSlice(
                          `0x${stack[stack.length - 2]}`,
                          12
                        )
                      ),
                      input: ethers.utils.hexDataSlice(
                        memoryBytes,
                        inputOffset,
                        inputOffset + inputSize
                      ),
                      value: value.toHexString(),
                    }
                  })
                return {
                  txHash: transaction.hash,
                  result: {
                    from: transaction.from,
                    to: transaction.to,
                    input: transaction.input,
                    value: transaction.value,
                    error: trace.failed ? "execution reverted" : undefined,
                    calls,
                  },
                }
              })
            )
          }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  }

  async function forwardedSubmissionFixture(): Promise<{
    provider: providers.Provider & {
      send(method: string, params: unknown[]): Promise<unknown>
    }
    bridge: string
    scanBlock: number
    historyEmitters: HistoryEmitter[]
    expectedChallengeKey: string
  }> {
    const [challenger, treasury] = await ethers.getSigners()
    const bridge = await (
      await ethers.getContractFactory("EcdsaFraudRouterBridgeStub")
    ).deploy(
      treasury.address,
      fraudWallet.pubKeyHash160,
      fraudWallet.ecdsaWalletID,
      constants.fraudChallengeDepositAmount
    )
    await bridge.deployed()

    const router = (await (
      await ethers.getContractFactory("EcdsaFraudRouter")
    ).deploy(bridge.address, ethers.constants.AddressZero)) as EcdsaFraudRouter
    await router.deployed()
    await bridge.setEcdsaFraudRouter(router.address)
    const forwarder = (await (
      await ethers.getContractFactory("RevertingEcdsaFraudChallenger")
    ).deploy(router.address)) as RevertingEcdsaFraudChallenger
    await forwarder.deployed()
    const receipt = await (
      await forwarder
        .connect(challenger)
        .submitFraudChallenge(
          fraudWallet.publicKey,
          nonWitnessSignSingleInputTx.preimageSha256,
          nonWitnessSignSingleInputTx.signature,
          { value: constants.fraudChallengeDepositAmount }
        )
    ).wait()
    const historyEmitters: HistoryEmitter[] = [
      {
        address: bridge.address,
        runtimeCodeHash: ethers.utils.keccak256(
          await ethers.provider.getCode(bridge.address)
        ),
        kind: "bridge",
        expectedUnrelatedBalance: "0",
      },
      {
        address: router.address,
        runtimeCodeHash: ethers.utils.keccak256(
          await ethers.provider.getCode(router.address)
        ),
        kind: "ecdsa-router-v3",
        expectedUnrelatedBalance: "0",
      },
    ]

    return {
      provider: hardhatCanonicalTraceProvider(),
      bridge: bridge.address,
      scanBlock: receipt.blockNumber,
      historyEmitters,
      expectedChallengeKey: ethers.BigNumber.from(
        ethers.utils.keccak256(
          ethers.utils.solidityPack(
            ["bytes", "bytes32"],
            [fraudWallet.publicKey, nonWitnessSignSingleInputTx.sighash]
          )
        )
      ).toString(),
    }
  }

  it("recovers forwarded legacy submissions from a unique Bridge call trace", async () => {
    const {
      provider,
      bridge,
      scanBlock,
      historyEmitters,
      expectedChallengeKey,
    } = await forwardedSubmissionFixture()
    const preflight = await buildLegacyInventorySourcePreflight(
      provider,
      bridge,
      scanBlock,
      scanBlock,
      historyEmitters
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
    const { provider, bridge, scanBlock, historyEmitters } =
      await forwardedSubmissionFixture()
    const traceUnavailableProvider = new Proxy(provider, {
      get(target, property, receiver) {
        if (property === "send") {
          return async (method: string, params: unknown[]) => {
            if (method === "debug_traceBlockByHash") {
              throw new Error("execution trace unavailable")
            }
            return target.send(method, params)
          }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    await expectRejected(
      buildLegacyInventorySourcePreflight(
        traceUnavailableProvider,
        bridge,
        scanBlock,
        scanBlock,
        historyEmitters
      ),
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
