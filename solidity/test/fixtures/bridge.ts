import { deployments, ethers, helpers } from "hardhat"
import type { Contract } from "ethers"
import type { Fragment } from "@ethersproject/abi"
import { randomBytes } from "crypto"
import { smock, FakeContract } from "@defi-wonderland/smock"
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
  ReservationRouter,
  IERC20,
} from "../../typechain"

/**
 * Merges Bridge ABI fragments with ReservationRouter ABI fragments, dropping
 * fragments the Bridge side already declares. This is used to build a complete
 * ABI for the Bridge contract, which delegates some calls to the router.
 */
export function mergeReservationRouterFragments(
  bridgeFragments: readonly Fragment[],
  routerAbi: unknown[]
): Fragment[] {
  const bridgeSignatures = new Set(
    bridgeFragments
      .filter((f) => f.type === "function" || f.type === "event")
      .map((f) => f.format())
  )
  return new ethers.utils.Interface(routerAbi).fragments.filter(
    (f) =>
      (f.type === "function" || f.type === "event") &&
      !bridgeSignatures.has(f.format())
  )
}

/**
 * The UTXO-reservation surface lives in the ReservationRouter and is reached
 * through the Bridge's fallback via delegatecall, so it is callable at the
 * Bridge address but absent from the Bridge artifact ABI. This helper
 * overlays the router ABI on a Bridge contract handle so tests can keep
 * calling the full surface on a single object.
 */
export async function attachReservationRouter<T extends Contract>(
  bridgeContract: T
): Promise<T & ReservationRouter> {
  const routerArtifact = await deployments.getArtifact("ReservationRouter")
  const bridgeAbi = bridgeContract.interface.fragments
  // Fragments both sides declare (`Initialized`, `governance()`, ...) are
  // dropped from the router side to avoid ethers' duplicate definition
  // warnings.
  const routerFragments = mergeReservationRouterFragments(
    bridgeAbi,
    routerArtifact.abi
  )
  const mergedInterface = new ethers.utils.Interface([
    ...bridgeAbi,
    ...routerFragments,
  ])
  return new ethers.Contract(
    bridgeContract.address,
    mergedInterface,
    bridgeContract.signer ?? bridgeContract.provider
  ) as unknown as T & ReservationRouter
}

/**
 * Common fixture for tests suites targeting the Bridge contract.
 */
export default async function bridgeFixture(): Promise<{
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
  relay: FakeContract<IRelay>
  walletRegistry: FakeContract<IWalletRegistry>
  bridge: Bridge & BridgeStub & ReservationRouter
  reimbursementPool: ReimbursementPool
  maintainerProxy: MaintainerProxy
  bridgeGovernance: BridgeGovernance
  redemptionWatchtower: RedemptionWatchtower
  deployBridge: (
    txProofDifficultyFactor: number,
    wireReservationRouter?: boolean
  ) => Promise<any>
}> {
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

  const bridge: Bridge & BridgeStub & ReservationRouter =
    await attachReservationRouter<Bridge & BridgeStub>(
      await helpers.contracts.getContract("Bridge")
    )

  const bridgeGovernance: BridgeGovernance =
    await helpers.contracts.getContract("BridgeGovernance")

  const walletRegistry = await smock.fake<IWalletRegistry>("IWalletRegistry", {
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

  const relay = await smock.fake<IRelay>("IRelay", {
    address: await (await bridge.contractReferences()).relay,
  })

  await bank.connect(governance).updateBridge(bridge.address)

  const redemptionWatchtower: RedemptionWatchtower =
    await helpers.contracts.getContract("RedemptionWatchtower")

  // Deploys a new instance of Bridge contract behind a proxy. Allows to
  // specify txProofDifficultyFactor. The new instance is deployed with
  // a random name to do not conflict with the main deployed instance.
  // Same parameters as in `05_deploy_bridge.ts` deployment script are used.
  const deployBridge = async (
    txProofDifficultyFactor: number,
    wireReservationRouter = true
  ) => {
    const [newBridge, newBridgeDeployment] = await helpers.upgrades.deployProxy(
      `Bridge_${randomBytes(8).toString("hex")}`,
      {
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
            DepositSweep: (
              await helpers.contracts.getContract("DepositSweep")
            ).address,
            Redemption: (
              await helpers.contracts.getContract("Redemption")
            ).address,
            Wallets: (await helpers.contracts.getContract("Wallets")).address,
            Fraud: (await helpers.contracts.getContract("Fraud")).address,
            MovingFunds: (
              await helpers.contracts.getContract("MovingFunds")
            ).address,
          },
        },
        proxyOpts: {
          kind: "transparent",
          // Allow external libraries linking. We need to ensure manually that the
          // external  libraries we link are upgrade safe, as the OpenZeppelin plugin
          // doesn't perform such a validation yet.
          // See: https://docs.openzeppelin.com/upgrades-plugins/1.x/faq#why-cant-i-use-external-libraries
          // The Bridge's fallback delegatecalls into the ReservationRouter
          // (see docs/rfc/rfc-13.adoc); this is guarded so it can only be
          // triggered through the proxy, not on the implementation itself.
          unsafeAllow: ["external-library-linking", "delegatecall"],
        },
      }
    )

    // Wire the reservation router the same way the deployment scripts do.
    // The router is stateless code, so the instance deployed by the fixture
    // deployments can serve this fresh Bridge as well.
    if (wireReservationRouter) {
      await (newBridge as Bridge & BridgeStub)
        .connect(deployer)
        .setReservationRouter(
          (
            await helpers.contracts.getContract("ReservationRouter")
          ).address
        )
    }

    return [
      await attachReservationRouter<Bridge & BridgeStub>(
        newBridge as Bridge & BridgeStub
      ),
      newBridgeDeployment,
    ]
  }

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
