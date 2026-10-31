import { expect } from "chai"
import path from "path"
import { ethers } from "hardhat"
import {
  REBATE_SELECTORS,
  TRAP_SELECTOR_UINT256_AMOUNT,
  assertBatchOrder,
  assertLayoutAppendOnly,
  assertSelectorPresence,
  buildRebateBatch,
  encodeExecuteBatch,
  encodeScheduleBatch,
  encodeUpgrade,
  hashOperationBatch,
  readDeployedBytecode,
  readStorageLayout,
  rebateSelectorPlan,
  scanSelectors,
  type RebateBatch,
  type StorageEntry,
} from "../../deploy/99_deploy_rebate_staking_reservation_implementation"

const PROXY_ADMIN = "0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706"
const STAKING_PROXY = "0x0184739C32edc3471D3e4860c8E39a5f3Ff85A45"
const STAKING_IMPL = "0x1111111111111111111111111111111111111111"
const BRIDGE_PROXY = "0x5e4861a80B55f035D899f66772117F00FA0E8e7B"
const BRIDGE_IMPL = "0x2222222222222222222222222222222222222222"
const SALT = ethers.id("test/salt")

const DEPLOYMENTS_MAINNET = path.join(
  __dirname,
  "..",
  "..",
  "deployments",
  "mainnet"
)
const recordPath = (name: string): string =>
  path.join(DEPLOYMENTS_MAINNET, `${name}.json`)

function goodBatch(): RebateBatch {
  return buildRebateBatch({
    proxyAdmin: PROXY_ADMIN,
    rebateStakingProxy: STAKING_PROXY,
    rebateStakingImplementation: STAKING_IMPL,
    bridgeProxy: BRIDGE_PROXY,
    bridgeImplementation: BRIDGE_IMPL,
    salt: SALT,
  })
}

const EXPECTED = {
  proxyAdmin: PROXY_ADMIN,
  rebateStakingProxy: STAKING_PROXY,
  rebateStakingImplementation: STAKING_IMPL,
  bridgeProxy: BRIDGE_PROXY,
  bridgeImplementation: BRIDGE_IMPL,
}

describe("deploy/99 deploy_rebate_staking_reservation_implementation", () => {
  describe("batch shape", () => {
    it("emits exactly two actions, both to the ProxyAdmin at zero value", () => {
      const batch = goodBatch()
      expect(batch.actions.length).to.equal(2)
      expect(batch.targets).to.deep.equal([PROXY_ADMIN, PROXY_ADMIN])
      expect(batch.values).to.deep.equal([BigInt(0), BigInt(0)])
      expect(batch.predecessor).to.equal(ethers.ZeroHash)
      expect(batch.salt).to.equal(SALT)
    })

    it("puts the RebateStaking upgrade at index 0 and the Bridge at index 1", () => {
      const batch = goodBatch()
      expect(batch.payloads[0]).to.equal(
        encodeUpgrade(STAKING_PROXY, STAKING_IMPL)
      )
      expect(batch.payloads[1]).to.equal(
        encodeUpgrade(BRIDGE_PROXY, BRIDGE_IMPL)
      )
    })

    it("has nothing between the two upgrades", () => {
      const batch = goodBatch()
      expect(batch.actions.map((action) => action.description)).to.deep.equal([
        "RebateStaking proxy upgrade via ProxyAdmin.upgrade()",
        "Bridge proxy upgrade via ProxyAdmin.upgrade()",
      ])
    })

    it("rejects a batch whose two actions were swapped", () => {
      // The reversed order is the thing this script exists to prevent, so
      // it must fail here and not reach a Timelock.
      const reversed = goodBatch()
      const staking = reversed.actions[0]
      const bridge = reversed.actions[1]
      reversed.actions = [bridge, staking]
      reversed.payloads = reversed.actions.map((action) => action.data)
      expect(() => assertBatchOrder(reversed, EXPECTED)).to.throw(
        /Action \[0\] upgrades .* expected the RebateStaking proxy/
      )
    })

    it("rejects a batch that installs the new Bridge before the new staking", () => {
      // Same two proxies in the right order, but the wrong implementation
      // parked at index 0: still a Bridge-first ceremony.
      const batch = buildRebateBatch({
        proxyAdmin: PROXY_ADMIN,
        rebateStakingProxy: STAKING_PROXY,
        rebateStakingImplementation: BRIDGE_IMPL,
        bridgeProxy: BRIDGE_PROXY,
        bridgeImplementation: STAKING_IMPL,
        salt: SALT,
      })
      expect(() => assertBatchOrder(batch, EXPECTED)).to.throw(
        /Action \[0\] installs/
      )
    })

    it("rejects a batch with a non-zero predecessor", () => {
      const batch = goodBatch()
      batch.predecessor = ethers.id("depends-on")
      expect(() => assertBatchOrder(batch, EXPECTED)).to.throw(
        /predecessor must be the zero hash/
      )
    })

    it("rejects a batch with a third action", () => {
      const batch = goodBatch()
      batch.actions.push({ ...batch.actions[1] })
      expect(() => assertBatchOrder(batch, EXPECTED)).to.throw(
        /exactly 2 actions/
      )
    })

    it("refuses to build a batch from one proxy twice", () => {
      expect(() =>
        buildRebateBatch({
          proxyAdmin: PROXY_ADMIN,
          rebateStakingProxy: BRIDGE_PROXY,
          rebateStakingImplementation: STAKING_IMPL,
          bridgeProxy: BRIDGE_PROXY,
          bridgeImplementation: BRIDGE_IMPL,
          salt: SALT,
        })
      ).to.throw(/same address/)
    })
  })

  describe("Timelock calldata", () => {
    const scheduleSelector = "0x8f2a0bb0"
    const executeSelector = "0x34c8a0d0"

    it("encodes scheduleBatch with the batch and the delay", () => {
      const batch = goodBatch()
      const calldata = encodeScheduleBatch(batch, BigInt(86400))
      expect(calldata.slice(0, 10)).to.equal(
        ethers.id(
          "scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)"
        ).slice(0, 10)
      )
      expect(calldata.slice(0, 10)).to.equal(scheduleSelector)
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ["address[]", "uint256[]", "bytes[]", "bytes32", "bytes32", "uint256"],
        `0x${calldata.slice(10)}`
      )
      expect(decoded[0]).to.deep.equal([PROXY_ADMIN, PROXY_ADMIN])
      expect((decoded[2] as string[])[0]).to.equal(batch.payloads[0])
      expect(decoded[5]).to.equal(BigInt(86400))
    })

    it("encodes executeBatch with the same batch and no delay", () => {
      const batch = goodBatch()
      const calldata = encodeExecuteBatch(batch)
      expect(calldata.slice(0, 10)).to.equal(
        ethers.id(
          "executeBatch(address[],uint256[],bytes[],bytes32,bytes32)"
        ).slice(0, 10)
      )
      expect(calldata.slice(0, 10)).to.equal(executeSelector)
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ["address[]", "uint256[]", "bytes[]", "bytes32", "bytes32"],
        `0x${calldata.slice(10)}`
      )
      expect(decoded[3]).to.equal(ethers.ZeroHash)
      expect(decoded[4]).to.equal(SALT)
    })

    it("derives an operation id that changes with the salt", () => {
      const batch = goodBatch()
      const other = buildRebateBatch({
        proxyAdmin: PROXY_ADMIN,
        rebateStakingProxy: STAKING_PROXY,
        rebateStakingImplementation: STAKING_IMPL,
        bridgeProxy: BRIDGE_PROXY,
        bridgeImplementation: BRIDGE_IMPL,
        salt: ethers.id("other/salt"),
      })
      expect(hashOperationBatch(batch)).to.not.equal(hashOperationBatch(other))
    })
  })

  describe("selector scan", () => {
    it("finds a selector wherever it sits in the bytecode", () => {
      const code = `0x600060006000${REBATE_SELECTORS.isRebateAuthorized.slice(
        2
      )}6000`
      expect(scanSelectors(code)[REBATE_SELECTORS.isRebateAuthorized]).to.equal(
        true
      )
      expect(scanSelectors(code)[REBATE_SELECTORS.cancelRebate]).to.equal(false)
    })

    it("passes a build that carries exactly the required selectors", () => {
      expect(() =>
        assertSelectorPresence("synthetic head", syntheticStakingCode(), {
          [REBATE_SELECTORS.isRebateAuthorized]: true,
          [REBATE_SELECTORS.setRebateAuthorization]: true,
          [REBATE_SELECTORS.applyForRebate]: true,
          [REBATE_SELECTORS.cancelRebate]: true,
        })
      ).to.not.throw()
    })

    it("fails a build that lacks isRebateAuthorized", () => {
      const withoutSelector = syntheticStakingCode().replace(
        REBATE_SELECTORS.isRebateAuthorized.slice(2),
        "00000000"
      )
      expect(() =>
        assertSelectorPresence("installed build", withoutSelector, {
          [REBATE_SELECTORS.isRebateAuthorized]: true,
        })
      ).to.throw(/96253dad is absent, expected present/)
    })

    it("fails a build that already answers the selector before the upgrade", () => {
      // If the installed implementation already had it, the ceremony plan
      // would be wrong and the batch would be unnecessary.
      expect(() =>
        assertSelectorPresence("installed build", syntheticStakingCode(), {
          [REBATE_SELECTORS.isRebateAuthorized]: false,
        })
      ).to.throw(/96253dad is present, expected absent/)
    })

    it("never accepts the uint256 amount selector for applyForRebate", () => {
      // 0xed6321ad is applyForRebate(address,uint256,uint8). Head uses
      // uint64 for the amount and TreasuryFeeType for the third argument.
      const trapCode = `0x6000${TRAP_SELECTOR_UINT256_AMOUNT.slice(2)}6000`
      expect(scanSelectors(trapCode)[TRAP_SELECTOR_UINT256_AMOUNT]).to.equal(
        true
      )
      expect(scanSelectors(trapCode)[REBATE_SELECTORS.applyForRebate]).to.equal(
        false
      )
    })

    it("states a plan where the installed build lacks both authorization selectors", () => {
      const plan = rebateSelectorPlan()
      expect(plan.installedStaking[REBATE_SELECTORS.isRebateAuthorized]).to.equal(
        false
      )
      expect(
        plan.installedStaking[REBATE_SELECTORS.setRebateAuthorization]
      ).to.equal(false)
      expect(plan.newStaking[REBATE_SELECTORS.isRebateAuthorized]).to.equal(true)
      expect(plan.newRedemption[REBATE_SELECTORS.isRebateAuthorized]).to.equal(
        true
      )
    })
  })

  describe("storage layout gate", () => {
    it("passes the real pre-upgrade layout against the head append", () => {
      const deployed = readStorageLayout(
        recordPath("RebateStakingTIP109HotfixImplementation")
      )
      expect(deployed.find((e) => e.label === "delegates")?.slot).to.equal("107")
      expect(deployed.find((e) => e.label === "__gap")?.slot).to.equal("108")
      expect(() =>
        assertLayoutAppendOnly(deployed, appendRebateAuthorizations(deployed))
      ).to.not.throw()
    })

    it("places rebateAuthorizations at 108 and shrinks the gap to 48", () => {
      const head = appendRebateAuthorizations(
        readStorageLayout(recordPath("RebateStakingTIP109HotfixImplementation"))
      )
      expect(head.find((e) => e.label === "rebateAuthorizations")?.slot).to.equal(
        "108"
      )
      const gap = head.find((e) => e.label === "__gap")
      expect(gap?.slot).to.equal("109")
      expect(gap?.type).to.equal("t_array(t_uint256)48_storage")
    })

    it("fails when the gap shrinks without a field claiming the slot", () => {
      const deployed = readStorageLayout(
        recordPath("RebateStakingTIP109HotfixImplementation")
      )
      const head = deployed.map((entry) =>
        entry.label === "__gap"
          ? { ...entry, slot: "109", type: "t_array(t_uint256)48_storage" }
          : entry
      )
      expect(() => assertLayoutAppendOnly(deployed, head)).to.throw(
        /slot 108 is neither a named field nor covered/
      )
    })

    it("fails when an existing field moves", () => {
      const deployed = readStorageLayout(
        recordPath("RebateStakingTIP109HotfixImplementation")
      )
      const head = appendRebateAuthorizations(deployed).map((entry) =>
        entry.label === "rebatePerToken" ? { ...entry, slot: "106" } : entry
      )
      expect(() => assertLayoutAppendOnly(deployed, head)).to.throw(
        /rebatePerToken moved/
      )
    })

    it("fails when the head layout ends below the deployed end", () => {
      const deployed = readStorageLayout(
        recordPath("RebateStakingTIP109HotfixImplementation")
      )
      const head = appendRebateAuthorizations(deployed)
        .filter((entry) => entry.label !== "__gap")
        .map((entry) => entry)
      expect(() => assertLayoutAppendOnly(deployed, head)).to.not.throw()
      const shortGap = head.map((entry) =>
        entry.label === "__gap"
          ? { ...entry, type: "t_array(t_uint256)40_storage" }
          : entry
      )
      expect(() => assertLayoutAppendOnly(deployed, shortGap)).to.throw(
        /head ends at slot/
      )
    })

    it("reads real bytecode out of the deployed record", () => {
      const code = readDeployedBytecode(
        recordPath("RebateStakingTIP109HotfixImplementation")
      )
      expect(code.startsWith("0x")).to.equal(true)
      // The installed build carries the two call selectors and not the
      // authorization pair; that is the finding the batch closes.
      const found = scanSelectors(code)
      expect(found[REBATE_SELECTORS.isRebateAuthorized]).to.equal(false)
      expect(found[REBATE_SELECTORS.setRebateAuthorization]).to.equal(false)
      expect(found[REBATE_SELECTORS.applyForRebate]).to.equal(true)
      expect(found[REBATE_SELECTORS.cancelRebate]).to.equal(true)
    })
  })
})

/** Bytecode carrying all four rebate selectors, for scan unit tests. */
function syntheticStakingCode(): string {
  return `0x6000${Object.values(REBATE_SELECTORS)
    .map((selector) => selector.slice(2))
    .join("6000")}6000`
}

/**
 * The head layout: `rebateAuthorizations` appended into the first slot of
 * the reserved gap, which then shrinks from 49 to 48 slots.
 */
function appendRebateAuthorizations(
  deployed: StorageEntry[]
) {
  const gap = deployed.find((entry) => entry.label === "__gap")
  if (gap === undefined) throw new Error("fixture: no __gap in deployed layout")
  const inserted = {
    label: "rebateAuthorizations",
    slot: gap.slot,
    offset: "0",
    type: "t_mapping(t_address,t_mapping(t_address,t_bool))",
  }
  return deployed.flatMap((entry) =>
    entry.label === "__gap"
      ? [
          inserted,
          { ...entry, slot: String(Number(entry.slot) + 1), type: "t_array(t_uint256)48_storage" },
        ]
      : [entry]
  )
}
