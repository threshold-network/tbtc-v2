import { artifacts, ethers } from "hardhat"
import { assert } from "chai"

// The Sui package consumes the shared `BTCDepositorWormhole` implementation.
// To carry the best-effort `finalizeDeposit` reimbursement path, the Sui
// package must compile against the LOCAL `solidity/` source rather than the
// published `@keep-network/tbtc-v2` npm copy, which predates that change.
//
// The discriminator between the two sources is the
// `DepositTxMaxFeeReimbursementSkipped` event: it exists only in the local
// source. The published copy also exposes a different `sourceName`
// (`@keep-network/tbtc-v2/...`) than the local one
// (`contracts/cross-chain/wormhole/...`). These two facts are the provenance
// assertions that prove the staged artifact came from the local source.
const STAGED_CONTRACT_NAME = "BTCDepositorWormhole"
const PROVENANCE_EVENT_NAME = "DepositTxMaxFeeReimbursementSkipped"
const LOCAL_SOURCE_NAME =
  "contracts/cross-chain/wormhole/BTCDepositorWormhole.sol"

// Core interface the staged artifact must expose, confirming the full
// implementation (and its inherited depositor surface) is staged rather than
// a stub. Mirrors the ABI-function scan used by the Arbitrum upgrade test.
const REQUIRED_ABI_FUNCTIONS = [
  "initialize",
  "initializeDeposit",
  "finalizeDeposit",
  "quoteFinalizeDeposit",
]

type AbiEntry = {
  type?: string
  name?: string
}

function getEventNames(abi: AbiEntry[]): string[] {
  return abi.flatMap((entry) => {
    if (entry.type !== "event" || typeof entry.name !== "string") {
      return []
    }

    return [entry.name]
  })
}

function getFunctionNames(abi: AbiEntry[]): string[] {
  return abi.flatMap((entry) => {
    if (entry.type !== "function" || typeof entry.name !== "string") {
      return []
    }

    return [entry.name]
  })
}

describe("Sui BTCDepositorWormhole artifact provenance", () => {
  it("resolves the staged BTCDepositorWormhole artifact carrying the best-effort reimbursement event", () => {
    const artifact = artifacts.readArtifactSync(STAGED_CONTRACT_NAME)
    const eventNames = getEventNames(artifact.abi as AbiEntry[])

    assert.include(
      eventNames,
      PROVENANCE_EVENT_NAME,
      `Staged ${STAGED_CONTRACT_NAME} artifact is missing the ${PROVENANCE_EVENT_NAME} event; ` +
        "it resolves the pre-best-effort published copy instead of the local source."
    )
  })

  it("resolves the staged artifact from the local solidity source, not the published copy", () => {
    const artifact = artifacts.readArtifactSync(STAGED_CONTRACT_NAME)

    assert.equal(
      artifact.sourceName,
      LOCAL_SOURCE_NAME,
      `Staged ${STAGED_CONTRACT_NAME} sourceName points at the published copy; ` +
        "it must resolve the local solidity source."
    )
  })

  it("resolves the staged artifact by its bare name without ambiguity", async () => {
    const artifact = artifacts.readArtifactSync(STAGED_CONTRACT_NAME)

    assert.equal(artifact.contractName, STAGED_CONTRACT_NAME)
    assert.isArray(artifact.abi)
    assert.isAbove(artifact.abi.length, 0)

    const factory = await ethers.getContractFactory(STAGED_CONTRACT_NAME)
    const initializeFragment = factory.interface.getFunction("initialize")

    assert.exists(factory)
    assert.exists(initializeFragment)
    assert.equal(initializeFragment.name, "initialize")
  })

  REQUIRED_ABI_FUNCTIONS.forEach((fnName) => {
    it(`exposes ${fnName} in the staged artifact ABI`, () => {
      const artifact = artifacts.readArtifactSync(STAGED_CONTRACT_NAME)
      const functionNames = getFunctionNames(artifact.abi as AbiEntry[])

      assert.include(functionNames, fnName)
    })
  })
})
