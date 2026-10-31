import { expect } from "chai"
import fs from "fs"
import path from "path"
import { artifacts, ethers } from "hardhat"
import {
  REBATE_SELECTORS,
  REBATE_TREASURY_FEE_MODE_ORDER,
  assertBridgeImplementationChanges,
  assertEnumMemberOrder,
  deployedLibraryRuntime,
  extractPushedAddresses,
  linkedLibraryAddresses,
  requireBridgeImplementationInput,
  TRAP_SELECTOR_UINT256_AMOUNT,
  assertBatchOrder,
  assertLayoutAppendOnly,
  assertLayoutCompatible,
  assertSelectorPresence,
  artifactLinkSites,
  bridgeRuntimeWithLibraries,
  buildRebateBatch,
  encodeExecuteBatch,
  encodeScheduleBatch,
  encodeUpgrade,
  hashOperationBatch,
  isSelfReferencingLibrary,
  proveBridgeIdentity,
  proveLibraryIdentity,
  readDeployedBytecode,
  readEnumMemberOrder,
  readStorageLayout,
  readStorageLayoutFile,
  rebateSelectorPlan,
  scanSelectors,
  semanticTypeId,
  type RebateBatch,
  type StorageEntry,
  type StorageLayout,
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
  describe("the Bridge implementation is an input, not a deployment", () => {
    it("refuses to run without BRIDGE_RESERVATION_IMPLEMENTATION", () => {
      expect(() => requireBridgeImplementationInput(undefined)).to.throw(
        /BRIDGE_RESERVATION_IMPLEMENTATION is required/
      )
      expect(() => requireBridgeImplementationInput("   ")).to.throw(
        /BRIDGE_RESERVATION_IMPLEMENTATION is required/
      )
    })

    it("says why the script does not deploy a Bridge implementation", () => {
      expect(() => requireBridgeImplementationInput(undefined)).to.throw(
        /does not deploy a Bridge implementation/
      )
    })

    it("accepts a named implementation and checksums it", () => {
      expect(
        requireBridgeImplementationInput(BRIDGE_IMPL.toLowerCase())
      ).to.equal(BRIDGE_IMPL)
    })

    it("refuses an implementation the Bridge proxy already delegates to", () => {
      expect(() =>
        assertBridgeImplementationChanges(BRIDGE_IMPL, BRIDGE_IMPL)
      ).to.throw(/would be a no-op/)
      expect(() =>
        assertBridgeImplementationChanges(
          BRIDGE_IMPL,
          BRIDGE_IMPL.toLowerCase()
        )
      ).to.throw(/would be a no-op/)
    })

    it("accepts an implementation that differs from the installed one", () => {
      expect(() =>
        assertBridgeImplementationChanges(BRIDGE_IMPL, STAKING_IMPL)
      ).to.not.throw()
    })

    it("finds the libraries a Bridge build links in its PUSH20 literals", () => {
      const code = `0x73${BRIDGE_IMPL.slice(2)}600173${STAKING_IMPL.slice(2)}`
      const found = extractPushedAddresses(code)
      expect(found).to.have.members([BRIDGE_IMPL, STAKING_IMPL])
    })

    it("ignores a 20-byte value that is not pushed as an address", () => {
      // PUSH32 with the address inside it is data, not a library link.
      const code = `0x7f${BRIDGE_IMPL.slice(2).padEnd(64, "0")}`
      expect(extractPushedAddresses(code)).to.deep.equal([])
    })

    it("leaves the proxy, the admin and the timelock out of the library list", () => {
      const code = `0x73${BRIDGE_IMPL.slice(2)}73${PROXY_ADMIN.slice(2)}`
      const libraries = linkedLibraryAddresses(code, [PROXY_ADMIN])
      expect(libraries).to.deep.equal([BRIDGE_IMPL])
    })
  })

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
    const executeSelector = "0xe38335e5"

    it("encodes scheduleBatch with the batch and the delay", () => {
      const batch = goodBatch()
      const calldata = encodeScheduleBatch(batch, BigInt(86400))
      expect(calldata.slice(0, 10)).to.equal(
        ethers
          .id(
            "scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)"
          )
          .slice(0, 10)
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
        ethers
          .id("executeBatch(address[],uint256[],bytes[],bytes32,bytes32)")
          .slice(0, 10)
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
      expect(
        scanSelectors(trapCode, [TRAP_SELECTOR_UINT256_AMOUNT])[
          TRAP_SELECTOR_UINT256_AMOUNT
        ]
      ).to.equal(true)
      expect(scanSelectors(trapCode)[REBATE_SELECTORS.applyForRebate]).to.equal(
        false
      )
    })

    it("states a plan where the installed build lacks both authorization selectors", () => {
      const plan = rebateSelectorPlan()
      expect(
        plan.installedStaking[REBATE_SELECTORS.isRebateAuthorized]
      ).to.equal(false)
      expect(
        plan.installedStaking[REBATE_SELECTORS.setRebateAuthorization]
      ).to.equal(false)
      expect(plan.newStaking[REBATE_SELECTORS.isRebateAuthorized]).to.equal(
        true
      )
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
      expect(deployed.find((e) => e.label === "delegates")?.slot).to.equal(
        "107"
      )
      expect(trailingGap(deployed)?.slot).to.equal("108")
      expect(() =>
        assertLayoutAppendOnly(deployed, appendRebateAuthorizations(deployed))
      ).to.not.throw()
    })

    it("places rebateAuthorizations at 108 and shrinks the gap to 48", () => {
      const head = appendRebateAuthorizations(
        readStorageLayout(recordPath("RebateStakingTIP109HotfixImplementation"))
      )
      expect(
        head.find((e) => e.label === "rebateAuthorizations")?.slot
      ).to.equal("108")
      const gap = trailingGap(head)
      expect(gap?.slot).to.equal("109")
      expect(gap?.type).to.equal("t_array(t_uint256)48_storage")
    })

    it("fails when the gap shrinks without a field claiming the slot", () => {
      const deployed = readStorageLayout(
        recordPath("RebateStakingTIP109HotfixImplementation")
      )
      const gap = trailingGap(deployed)
      const head = deployed.map((entry) =>
        entry === gap
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
      const head = appendRebateAuthorizations(deployed).filter(
        (entry) => entry !== trailingGap(appendRebateAuthorizations(deployed))
      )
      expect(() => assertLayoutAppendOnly(deployed, head)).to.not.throw()
      const trailing = trailingGap(head)
      const shortGap = head.map((entry) =>
        entry === trailing
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

  describe("the storage-layout comparison is semantic, not by type id", () => {
    it("gives two builds of the same source the same type identity", () => {
      // solc's type ids are compilation-local handles: the same struct is
      // `t_struct(Stake)34999_storage` in one compilation and
      // `t_struct(Stake)36253_storage` in the next. The gate has to see
      // one struct, not two.
      //
      // The `types` table is what carries the meaning: its `label` field
      // has no AST id in it.
      const deployed = readStorageLayoutFile(
        recordPath("RebateStakingTIP109HotfixImplementation")
      )
      const stakes = deployed.storage.find((entry) => entry.label === "stakes")
      if (stakes === undefined) throw new Error("no stakes field")
      expect(semanticTypeId(stakes.type, deployed.types)).to.equal(
        "mapping(address => struct RebateStaking.Stake)"
      )
      const token = deployed.storage.find((entry) => entry.label === "token")
      if (token === undefined) throw new Error("no token field")
      expect(semanticTypeId(token.type, deployed.types)).to.equal(
        "contract IERC20Upgradeable"
      )
      // Without a types table the AST id is stripped instead, so an
      // unknown type still compares by shape rather than by numbering.
      expect(semanticTypeId("t_struct(Stake)34999_storage")).to.equal(
        "t_struct(Stake)"
      )
      expect(semanticTypeId("t_struct(Stake)36253_storage")).to.equal(
        "t_struct(Stake)"
      )
      expect(semanticTypeId("t_contract(IERC20Upgradeable)13046")).to.equal(
        semanticTypeId("t_contract(IERC20Upgradeable)13055")
      )
    })

    it("keeps genuinely different types apart", () => {
      expect(semanticTypeId("t_uint256")).to.not.equal(
        semanticTypeId("t_uint128")
      )
      expect(semanticTypeId("t_struct(Stake)1_storage")).to.not.equal(
        semanticTypeId("t_struct(Rebate)1_storage")
      )
      expect(semanticTypeId("t_array(t_uint256)49_storage")).to.not.equal(
        semanticTypeId("t_array(t_uint256)48_storage")
      )
    })

    it("accepts the real deployed layout against the real compiled head layout", async () => {
      // This is the check the gate exists for, against the two layouts the
      // ceremony actually compares: the deployed implementation's record
      // and the layout the compiler produces for the head source.
      //
      // The head layout comes out of the compiler, so its type ids are
      // numbered differently from the deployed record's. An id-by-id
      // comparison rejects this upgrade; a semantic one accepts it.
      const deployed = readStorageLayoutFile(
        recordPath("RebateStakingTIP109HotfixImplementation")
      )
      const head = await compiledHeadLayout()

      // The two layouts really do differ in their type ids: that is the
      // property that broke the previous comparison.
      const deployedToken = deployed.storage.find(
        (entry) => entry.label === "token"
      )
      const headToken = head.storage.find((entry) => entry.label === "token")
      expect(deployedToken).to.not.equal(undefined)
      expect(headToken).to.not.equal(undefined)
      expect(deployedToken?.type).to.not.equal(headToken?.type)
      expect(
        semanticTypeId(deployedToken?.type ?? "", deployed.types)
      ).to.equal(semanticTypeId(headToken?.type ?? "", head.types))

      expect(() => assertLayoutCompatible(deployed, head)).to.not.throw()
      expect(() =>
        assertLayoutAppendOnly(deployed.storage, head.storage, {
          deployed,
          head,
        })
      ).to.not.throw()
    })

    it("rejects a head layout whose field moved", async () => {
      const deployed = readStorageLayoutFile(
        recordPath("RebateStakingTIP109HotfixImplementation")
      )
      const head = await compiledHeadLayout()
      const moved = JSON.parse(JSON.stringify(head)) as StorageLayout
      const field = moved.storage.find(
        (entry) => entry.label === "rebatePerToken"
      )
      if (field === undefined) throw new Error("no rebatePerToken field")
      field.slot = "99"
      expect(() => assertLayoutCompatible(deployed, moved)).to.throw(
        /incompatible storage layout/i
      )
    })

    it("rejects a head layout whose two fields swapped slots", async () => {
      // The counterexample the review named for the rehearsal: a build
      // that swaps `rollingWindow` and `unstakingPeriod` keeps all four
      // selectors and every top-level slot count, so the rehearsal's
      // redemption cases would all pass while the staking parameters mean
      // something else. The production gate has to reject it.
      const deployed = readStorageLayoutFile(
        recordPath("RebateStakingTIP109HotfixImplementation")
      )
      const head = await compiledHeadLayout()
      const swapped = JSON.parse(JSON.stringify(head)) as StorageLayout
      const window = swapped.storage.find(
        (entry) => entry.label === "rollingWindow"
      )
      const unstaking = swapped.storage.find(
        (entry) => entry.label === "unstakingPeriod"
      )
      if (window === undefined) throw new Error("no rollingWindow field")
      if (unstaking === undefined) throw new Error("no unstakingPeriod field")
      const windowSlot = window.slot
      window.slot = unstaking.slot
      unstaking.slot = windowSlot
      expect(() => assertLayoutCompatible(deployed, swapped)).to.throw(
        /incompatible storage layout/i
      )
      expect(() =>
        assertLayoutAppendOnly(deployed.storage, swapped.storage, {
          deployed,
          head: swapped,
        })
      ).to.throw(/moved from slot/)
    })

    it("rejects a head layout whose field changed type", async () => {
      const deployed = readStorageLayoutFile(
        recordPath("RebateStakingTIP109HotfixImplementation")
      )
      const head = await compiledHeadLayout()
      const retyped = JSON.parse(JSON.stringify(head)) as StorageLayout
      // `rollingWindow` is a uint256 on both sides; make it a uint128 and
      // the storage really differs.
      const field = retyped.storage.find(
        (entry) => entry.label === "rollingWindow"
      )
      if (field === undefined) throw new Error("no rollingWindow field")
      field.type = "t_uint128"
      retyped.types.t_uint128 = {
        encoding: "inplace",
        label: "uint128",
        numberOfBytes: "16",
      }
      expect(() => assertLayoutCompatible(deployed, retyped)).to.throw(
        /incompatible storage layout/i
      )
    })

    it("reads the deployed record's types table", () => {
      const layout = readStorageLayoutFile(
        recordPath("RebateStakingTIP109HotfixImplementation")
      )
      expect(Object.keys(layout.types).length).to.be.greaterThan(0)
      // The struct behind `stakes` has to be in the table, or the layout
      // could not be compared by meaning at all.
      const stakes = layout.storage.find((entry) => entry.label === "stakes")
      if (stakes === undefined) throw new Error("no stakes field")
      expect(layout.types[stakes.type]).to.not.equal(undefined)
    })
  })

  describe("the Bridge input is proven to be the Bridge", () => {
    it("rejects a Redemption library address as the Bridge implementation", async () => {
      // The counterexample the review named: the `Redemption` library
      // carries code, it is not the installed implementation, and it does
      // carry the `isRebateAuthorized` selector, so every other check in
      // the pre-flight accepts it. The identity proof has to reject it.
      const artifact = await artifacts.readArtifact("Bridge")
      const linkSites = artifactLinkSites(artifact.deployedLinkReferences)
      const redemption = await artifacts.readArtifact("Redemption")

      // A library's runtime starts with a PUSH20 of its own address. The
      // deployed library has that address written at its first link site,
      // so build the runtime the library would actually have.
      const libraryAddress = "0x1111111111111111111111111111111111111111"
      const selfRuntime = `0x73${libraryAddress.slice(2)}${redemption.deployedBytecode.slice(2).slice(42)}`

      const identity = proveBridgeIdentity({
        candidateAddress: libraryAddress,
        candidateRuntime: selfRuntime,
        artifactRuntime: artifact.deployedBytecode,
        linkSites,
      })
      expect(identity.isBridge).to.equal(false)
      expect(identity.reason).to.match(/refers to itself|its own/i)
    })

    it("recognises a library by its own address in its runtime", () => {
      const libraryAddress = "0x1111111111111111111111111111111111111111"
      const selfRuntime = `0x73${libraryAddress.slice(2)}60006000fd`
      expect(isSelfReferencingLibrary(libraryAddress, selfRuntime)).to.equal(
        true
      )
      expect(
        isSelfReferencingLibrary(
          "0x2222222222222222222222222222222222222222",
          selfRuntime
        )
      ).to.equal(false)
    })

    it("rejects a runtime that is not the Bridge at all", async () => {
      const artifact = await artifacts.readArtifact("Bridge")
      const linkSites = artifactLinkSites(artifact.deployedLinkReferences)
      // A runtime of the right length that is not the Bridge: the same
      // length as the artifact, so the rejection is about the bytes and
      // not about a truncated runtime.
      const notTheBridge = `0x${"60".repeat(
        artifact.deployedBytecode.length / 2 - 1
      )}`
      const identity = proveBridgeIdentity({
        candidateAddress: "0x2222222222222222222222222222222222222222",
        candidateRuntime: notTheBridge,
        artifactRuntime: artifact.deployedBytecode,
        linkSites,
      })
      expect(identity.isBridge).to.equal(false)
      expect(identity.reason).to.match(/differs from the Bridge artifact/)
    })

    it("accepts the real Bridge build linked against real libraries", async () => {
      // The positive control: the Bridge artifact, with its link
      // placeholders replaced by the addresses a real deployment links.
      const artifact = await artifacts.readArtifact("Bridge")
      const linkSites = artifactLinkSites(artifact.deployedLinkReferences)
      expect(linkSites.length).to.be.greaterThan(0)

      const libraries: Record<string, string> = {}
      // Give each library its own address, so the link sites are distinct:
      // two libraries sharing an address would be a build that links the
      // same library twice.
      let counter = 0x11
      linkSites.forEach((site) => {
        if (libraries[site.library] === undefined) {
          libraries[site.library] = ethers.getAddress(
            `0x${counter.toString(16).padStart(2, "0").repeat(20)}`
          )
          counter += 1
        }
      })
      const linked = bridgeRuntimeWithLibraries(
        artifact.deployedBytecode,
        linkSites,
        libraries
      )
      const identity = proveBridgeIdentity({
        candidateAddress: "0x3333333333333333333333333333333333333333",
        candidateRuntime: linked,
        artifactRuntime: artifact.deployedBytecode,
        linkSites,
      })
      expect(identity.isBridge).to.equal(true)
      expect(identity.libraries.Redemption).to.not.equal(undefined)
      expect(identity.libraries.Redemption).to.equal(libraries.Redemption)
    })
  })

  describe("every linked library is verified, not only Redemption", () => {
    it("accepts a library whose runtime is the release build", async () => {
      // The positive control for the library check: the runtime a library
      // really has on chain. solc writes the library's own address into the
      // `PUSH20` at the head of the deployed runtime, so the on-chain
      // runtime is the artifact's runtime with that slot filled in.
      const deposit = await artifacts.readArtifact("Deposit")
      const address = "0x4444444444444444444444444444444444444444"
      const onChainRuntime = deployedLibraryRuntime(
        deposit.deployedBytecode,
        address
      )
      const result = proveLibraryIdentity({
        name: "Deposit",
        address,
        onChainRuntime,
        artifactRuntime: deposit.deployedBytecode,
      })
      expect(result.matches).to.equal(true)
    })

    it("rejects a library linked to the wrong build", async () => {
      // The counterexample the review named: the Bridge links the correct
      // `Redemption` library but a wrong-version `Deposit` library. The
      // Bridge wrapper is byte-identical either way, so only a check of
      // the library itself catches it.
      const deposit = await artifacts.readArtifact("Deposit")
      const address = "0x4444444444444444444444444444444444444444"
      // A runtime of the right shape that is not this build: the deployed
      // runtime with one byte changed somewhere else in it.
      const deployed = deployedLibraryRuntime(
        deposit.deployedBytecode,
        address
      )
      const tampered = `0x${deployed
        .slice(2)
        .match(/.{2}/g)
        ?.map((byte, index) => (index === 50 ? "ff" : byte))
        .join("")}`
      const result = proveLibraryIdentity({
        name: "Deposit",
        address,
        onChainRuntime: tampered,
        artifactRuntime: deposit.deployedBytecode,
      })
      expect(result.matches).to.equal(false)
      expect(result.reason).to.match(/is not the Deposit build/)
    })

    it("rejects a library address with no code", async () => {
      // An address with no code is not a library, and the check has to say
      // so rather than pass it through.
      const deposit = await artifacts.readArtifact("Deposit")
      const address = "0x5555555555555555555555555555555555555555"
      const result = proveLibraryIdentity({
        name: "Deposit",
        address,
        onChainRuntime: "0x",
        artifactRuntime: deposit.deployedBytecode,
      })
      expect(result.matches).to.equal(false)
    })

    it("rejects a library runtime that does not carry its own address", async () => {
      // A runtime that is not a library's runtime at all: the build's
      // bytes with the self-reference left as zeros. The check has to
      // refuse it rather than treat the zeros as the self-reference.
      const deposit = await artifacts.readArtifact("Deposit")
      const address = "0x6666666666666666666666666666666666666666"
      const result = proveLibraryIdentity({
        name: "Deposit",
        address,
        onChainRuntime: deposit.deployedBytecode,
        artifactRuntime: deposit.deployedBytecode,
      })
      expect(result.matches).to.equal(false)
      expect(result.reason).to.match(/carries the library's own address/)
    })

    it("rejects a library deployed at another address", async () => {
      // The exact counterexample the review named: the Bridge links
      // `Deposit` at an address, but the code there is a library that was
      // deployed somewhere else. The Bridge wrapper is byte-identical
      // either way, so only this check sees it.
      const deposit = await artifacts.readArtifact("Deposit")
      const deployedAt = "0x9999999999999999999999999999999999999999"
      const linkedAt = "0x8888888888888888888888888888888888888888"
      const onChainRuntime = deployedLibraryRuntime(
        deposit.deployedBytecode,
        deployedAt
      )
      const result = proveLibraryIdentity({
        name: "Deposit",
        address: linkedAt,
        onChainRuntime,
        artifactRuntime: deposit.deployedBytecode,
      })
      expect(result.matches).to.equal(false)
      expect(result.reason).to.match(/was not deployed at this address/)
    })

    it("names every library the Bridge links", async () => {
      // The point of the check: the identity proof names all six linked
      // libraries, not only `Redemption`, so every one of them can be
      // verified.
      const artifact = await artifacts.readArtifact("Bridge")
      const linkSites = artifactLinkSites(artifact.deployedLinkReferences)
      const libraries: Record<string, string> = {}
      let counter = 0x11
      linkSites.forEach((site) => {
        if (libraries[site.library] === undefined) {
          libraries[site.library] = ethers.getAddress(
            `0x${counter.toString(16).padStart(2, "0").repeat(20)}`
          )
          counter += 1
        }
      })
      const linked = bridgeRuntimeWithLibraries(
        artifact.deployedBytecode,
        linkSites,
        libraries
      )
      const identity = proveBridgeIdentity({
        candidateAddress: "0x3333333333333333333333333333333333333333",
        candidateRuntime: linked,
        artifactRuntime: artifact.deployedBytecode,
        linkSites,
      })
      expect(identity.isBridge).to.equal(true)
      expect(Object.keys(identity.libraries).sort()).to.deep.equal([
        "Deposit",
        "DepositSweep",
        "Fraud",
        "MovingFunds",
        "Redemption",
        "Wallets",
      ])
    })
  })

  describe("the fee-mode enum order is pinned", () => {
    it("accepts the order the source declares", () => {
      const source = stakingSource()
      const order = assertEnumMemberOrder({
        source,
        enumName: "RebateTreasuryFeeMode",
        expected: REBATE_TREASURY_FEE_MODE_ORDER,
      })
      expect(order).to.deep.equal(["Both", "DepositOnly", "RedemptionOnly"])
    })

    it("rejects a reordered enum", () => {
      // The counterexample the review named: reordering `DepositOnly` and
      // `RedemptionOnly` leaves the stored byte width, the labels, the
      // top-level slots and the selector plan unchanged, so every layout
      // assertion accepts it while every persisted value of 1 or 2
      // acquires the opposite fee policy.
      const source = stakingSource()
      const reordered = source.replace(
        "enum RebateTreasuryFeeMode {\n        Both,\n        DepositOnly,\n        RedemptionOnly\n    }",
        "enum RebateTreasuryFeeMode {\n        Both,\n        RedemptionOnly,\n        DepositOnly\n    }"
      )
      expect(reordered).to.not.equal(source)
      expect(() =>
        assertEnumMemberOrder({
          source: reordered,
          enumName: "RebateTreasuryFeeMode",
          expected: REBATE_TREASURY_FEE_MODE_ORDER,
        })
      ).to.throw(/declares \[Both, RedemptionOnly, DepositOnly\]/)
    })

    it("rejects an enum with a member added", () => {
      const source = stakingSource()
      const extended = source.replace(
        "enum RebateTreasuryFeeMode {\n        Both,",
        "enum RebateTreasuryFeeMode {\n        Both,\n        Extra,"
      )
      expect(() =>
        assertEnumMemberOrder({
          source: extended,
          enumName: "RebateTreasuryFeeMode",
          expected: REBATE_TREASURY_FEE_MODE_ORDER,
        })
      ).to.throw(/declares/)
    })

    it("reads the order out of the source", () => {
      // The order is read from the source on every run, so a reorder in the
      // source is a change the gate sees rather than a change it cannot.
      const order = readEnumMemberOrder(
        stakingSource(),
        "RebateTreasuryFeeMode"
      )
      expect(order).to.deep.equal(["Both", "DepositOnly", "RedemptionOnly"])
    })
  })
})

/**
 * The storage layout the compiler produces for the head `RebateStaking`.
 *
 * Read out of the build info rather than hand-written, so the test
 * compares the two layouts the ceremony actually compares: the deployed
 * implementation's record on disk and the compiler's own output for the
 * head source.
 */
async function compiledHeadLayout(): Promise<StorageLayout> {
  const buildInfo = await artifacts.getBuildInfo(
    "contracts/bridge/RebateStaking.sol:RebateStaking"
  )
  if (buildInfo === undefined) {
    throw new Error("no build info for the head RebateStaking")
  }
  const output =
    buildInfo.output.contracts["contracts/bridge/RebateStaking.sol"]
  const contract = output?.RebateStaking
  if (contract === undefined || !("storageLayout" in contract)) {
    throw new Error(
      "the head RebateStaking build info carries no storage layout"
    )
  }
  const layout: unknown = contract.storageLayout
  return layout as StorageLayout
}

/** The `__gap` that reserves the tail: the one with the highest slot. */
function trailingGap(entries: StorageEntry[]): StorageEntry | undefined {
  return entries
    .filter((entry) => entry.label === "__gap")
    .sort((a, b) => Number(a.slot) - Number(b.slot))
    .pop()
}

/**
 * The staking contract's source, read from disk.
 *
 * The enum order is read from the source rather than from the compiled
 * layout, because the deployed layout carries no enum members: the pinned
 * solc 0.8.17 does not write them. So the source is the only place the
 * deployed order can be read from.
 */
function stakingSource(): string {
  return fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "..",
      "contracts",
      "bridge",
      "RebateStaking.sol"
    ),
    "utf8"
  )
}

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
function appendRebateAuthorizations(deployed: StorageEntry[]) {
  const gap = trailingGap(deployed)
  if (gap === undefined) throw new Error("fixture: no __gap in deployed layout")
  const inserted = {
    label: "rebateAuthorizations",
    slot: gap.slot,
    offset: "0",
    type: "t_mapping(t_address,t_mapping(t_address,t_bool))",
  }
  return deployed.flatMap((entry) =>
    entry === gap
      ? [
          inserted,
          {
            ...entry,
            slot: String(Number(entry.slot) + 1),
            type: "t_array(t_uint256)48_storage",
          },
        ]
      : [entry]
  )
}
