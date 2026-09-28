import { deployments, ethers, helpers } from "hardhat"
import { randomBytes } from "crypto"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type {
  Bank,
  BankStub,
  Bridge,
  BridgeStub,
  IWalletRegistry,
  ReimbursementPool,
  MaintainerProxy,
  TBTC,
  TBTCVault,
  VendingMachine,
  BridgeGovernance,
  IRelay,
  RedemptionWatchtower,
  RebateStaking,
  IERC20,
} from "../../typechain"
import { createMock } from "../helpers/mock"
import { seedReservationTerms } from "../helpers/reservation-terms"
import {
  bridgeStateEntry,
  getBridgeStorageLayout,
} from "./bridgeStorageLayoutSnapshot"

import type { Mock } from "../helpers/mock"

type BridgeFixture = {
  deployer: SignerWithAddress
  governance: SignerWithAddress
  spvMaintainer: SignerWithAddress
  thirdParty: SignerWithAddress
  treasury: SignerWithAddress
  redemptionWatchtowerManager: SignerWithAddress
  guardians: SignerWithAddress[]
  tbtc: TBTC
  vendingMachine: VendingMachine
  tbtcVault: TBTCVault
  bank: Bank & BankStub
  relay: Mock<IRelay>
  walletRegistry: Mock<IWalletRegistry>
  bridge: Bridge & BridgeStub
  reimbursementPool: ReimbursementPool
  maintainerProxy: MaintainerProxy
  bridgeGovernance: BridgeGovernance
  redemptionWatchtower: RedemptionWatchtower
  t: IERC20
  rebateStaking: RebateStaking
  deployBridge: (txProofDifficultyFactor: number) => Promise<any>
}

// `Reservation.MAX_RESERVATION_TERM_ID`: the setter writes no id above it.
const MAX_RESERVATION_TERM_ID = 8

/**
 * Common fixture body for tests suites targeting the Bridge contract. The
 * reservation term table holds whatever the deploy scripts seeded.
 */
async function deployedBridgeFixture(): Promise<BridgeFixture> {
  await deployments.fixture()

  const {
    deployer,
    governance,
    spvMaintainer,
    treasury,
    redemptionWatchtowerManager,
  } = await helpers.signers.getNamedSigners()

  const [thirdParty, guardian1, guardian2, guardian3] =
    await helpers.signers.getUnnamedSigners()

  const guardians = [guardian1, guardian2, guardian3]

  const tbtc: TBTC = await helpers.contracts.getContract("TBTC")

  const vendingMachine: VendingMachine = await helpers.contracts.getContract(
    "VendingMachine"
  )

  const tbtcVault: TBTCVault = await helpers.contracts.getContract("TBTCVault")

  const bank: Bank & BankStub = await helpers.contracts.getContract("Bank")

  const t: IERC20 = await helpers.contracts.getContract("T")

  const rebateStaking: RebateStaking = await helpers.contracts.getContract(
    "RebateStaking"
  )

  const bridge: Bridge & BridgeStub = await helpers.contracts.getContract(
    "Bridge"
  )

  const bridgeGovernance: BridgeGovernance =
    await helpers.contracts.getContract("BridgeGovernance")

  const walletRegistry = await createMock<IWalletRegistry>("IWalletRegistry", {
    address: await (await bridge.contractReferences()).ecdsaWalletRegistry,
  })
  // Fund the `walletRegistry` account so it's possible to mock sending requests
  // from it.
  await deployer.sendTransaction({
    to: walletRegistry.address,
    value: ethers.utils.parseEther("100"),
  })

  const reimbursementPool: ReimbursementPool =
    await helpers.contracts.getContract("ReimbursementPool")

  const maintainerProxy: MaintainerProxy = await helpers.contracts.getContract(
    "MaintainerProxy"
  )

  const relay = await createMock<IRelay>("IRelay", {
    address: await (await bridge.contractReferences()).relay,
  })

  await bank.connect(governance).updateBridge(bridge.address)

  const redemptionWatchtower: RedemptionWatchtower =
    await helpers.contracts.getContract("RedemptionWatchtower")

  // Deploys a new instance of Bridge contract behind a proxy. Allows to
  // specify txProofDifficultyFactor. The new instance is deployed with
  // a random name to do not conflict with the main deployed instance.
  // Same parameters as in `05_deploy_bridge.ts` deployment script are used.
  const deployBridge = async (txProofDifficultyFactor: number) =>
    helpers.upgrades.deployProxy(`Bridge_${randomBytes(8).toString("hex")}`, {
      contractName: "BridgeStub",
      initializerArgs: [
        bank.address,
        relay.address,
        treasury.address,
        walletRegistry.address,
        reimbursementPool.address,
        txProofDifficultyFactor,
      ],
      factoryOpts: {
        signer: deployer,
        libraries: {
          Deposit: (await helpers.contracts.getContract("Deposit")).address,
          DepositSweep: (await helpers.contracts.getContract("DepositSweep"))
            .address,
          Redemption: (await helpers.contracts.getContract("Redemption"))
            .address,
          Wallets: (await helpers.contracts.getContract("Wallets")).address,
          Fraud: (await helpers.contracts.getContract("Fraud")).address,
          MovingFunds: (await helpers.contracts.getContract("MovingFunds"))
            .address,
        },
      },
      proxyOpts: {
        kind: "transparent",
        // Allow external libraries linking. We need to ensure manually that the
        // external  libraries we link are upgrade safe, as the OpenZeppelin plugin
        // doesn't perform such a validation yet.
        // See: https://docs.openzeppelin.com/upgrades-plugins/1.x/faq#why-cant-i-use-external-libraries
        //
        // `delegatecall` is allowed for the reservation-router fallback facet
        // (`Bridge.fallback()`); see the same allowance and its rationale in
        // `deploy/06_deploy_bridge.ts`.
        unsafeAllow: ["external-library-linking", "delegatecall"],
      },
    })

  return {
    deployer,
    governance,
    spvMaintainer,
    thirdParty,
    treasury,
    redemptionWatchtowerManager,
    guardians,
    tbtc,
    vendingMachine,
    tbtcVault,
    bank,
    relay,
    walletRegistry,
    bridge,
    reimbursementPool,
    maintainerProxy,
    bridgeGovernance,
    redemptionWatchtower,
    t,
    rebateStaking,
    deployBridge,
  }
}

/**
 * Zeroes every entry of the Bridge's reservation term table, which the deploy
 * scripts seed. Each entry occupies one storage slot and the table keeps no
 * other state (its largest- and smallest-entry helpers loop the ids), so the
 * result is the state of a table that was never written.
 */
async function clearReservationTerms(bridge: Bridge): Promise<void> {
  const layout = await getBridgeStorageLayout()
  const bridgeState = bridgeStateEntry(layout)
  const member = layout.types[bridgeState.type].members?.find(
    (entry) => entry.label === "reservationTerms"
  )
  const valueType = member && layout.types[member.type].value
  if (!member || !valueType || layout.types[valueType].numberOfBytes !== "32") {
    throw new Error("reservationTerms is not a mapping to one-slot entries")
  }
  const mappingSlot = ethers.BigNumber.from(bridgeState.slot).add(member.slot)

  for (let termId = 1; termId <= MAX_RESERVATION_TERM_ID; termId++) {
    const entrySlot = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["uint256", "uint256"],
        [termId, mappingSlot]
      )
    )
    // eslint-disable-next-line no-await-in-loop
    await ethers.provider.send("hardhat_setStorageAt", [
      bridge.address,
      entrySlot,
      ethers.constants.HashZero,
    ])
  }
}

/**
 * Common fixture for tests suites targeting the Bridge contract. Seeds the
 * Bridge's reservation term table with the ruled entries
 * (`RESERVATION_TERM_ENTRIES`) through the governance-only setter; ids that a
 * deploy script already seeded with the same values are skipped.
 */
async function bridgeFixture(): Promise<BridgeFixture> {
  const fixture = await deployedBridgeFixture()
  await seedReservationTerms(fixture.bridge)
  return fixture
}

/**
 * The Bridge fixture with an empty reservation term table: the deploy
 * scripts' entries are cleared.
 */
async function unseededBridgeFixture(): Promise<BridgeFixture> {
  const fixture = await deployedBridgeFixture()
  await clearReservationTerms(fixture.bridge)
  return fixture
}

/**
 * Built with `deployments.createFixture` rather than exported bare for
 * `waffle.loadFixture`, because the two snapshot stacks collide.
 *
 * This fixture runs `deployments.fixture()` and only afterwards installs mock
 * bytecode over the real `WalletRegistry` and `LightRelay` addresses with
 * `hardhat_setCode`. A bare `deployments.fixture()` elsewhere in the run —
 * `test/bridge/Deployment.test.ts` does exactly that — reverts to
 * hardhat-deploy's snapshot from *below* those mocks and invalidates every
 * snapshot taken after it.
 *
 * waffle's loader discards the boolean `evm_revert` returns, so from that
 * point on it hands back cached handles over state where the mocks no longer
 * exist, and a `relay.getX.returns(...)` becomes a call to the real
 * `LightRelay`, which has no such selector and no fallback.
 * `deployments.createFixture` checks that boolean and re-runs the fixture
 * instead, which is the property this needs.
 *
 * This was harmless while smock's fakes lived in the JavaScript process, where
 * no `evm_revert` could remove them. Putting mocks on the chain made it fatal.
 */
export default deployments.createFixture(bridgeFixture)

/**
 * The Bridge fixture with an empty reservation term table, for tests of
 * empty-table behaviour. Built with `deployments.createFixture` for the same
 * reason as the default export. Tests using it assert the table is empty
 * before relying on it.
 */
export const bridgeFixtureWithoutReservationTerms = deployments.createFixture(
  unseededBridgeFixture
)
