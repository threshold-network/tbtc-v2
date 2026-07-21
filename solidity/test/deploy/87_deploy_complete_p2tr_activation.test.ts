/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-expressions */

import { expect } from "chai"
import { constants, providers, utils } from "ethers"
import { artifacts } from "hardhat"
import deployCompleteP2TRActivation, {
  ACTIVATION_ARTIFACT_SCHEMA,
  AuthorityKind,
  CoverageInventoryDocument,
  PreparedCall,
  assertRuntimeCode,
  buildAuthorityEnvelope,
  classifyAuthority,
  deriveCoverageInventory,
  reconcilePhase,
} from "../../deploy/87_deploy_complete_p2tr_activation"

describe("Deploy Script 87: COMPLETE_V2 activation", () => {
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

  for (const kind of ["safe", "timelock"] as AuthorityKind[]) {
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
      "tbtc/complete-p2tr-activation/v2"
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
