import { deployments, ethers, helpers } from "hardhat"
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
  IERC20,
  EcdsaFraudRouter,
  P2TRSignatureFraudRouter,
} from "../../typechain"

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
  bridge: Bridge & BridgeStub
  reimbursementPool: ReimbursementPool
  maintainerProxy: MaintainerProxy
  bridgeGovernance: BridgeGovernance
  redemptionWatchtower: RedemptionWatchtower
  t: IERC20
  rebateStaking: RebateStaking
  ecdsaFraudRouter: EcdsaFraudRouter
  p2trFraudRouter: P2TRSignatureFraudRouter
  deployBridge: (txProofDifficultyFactor: number) => Promise<any>
}> {
  // Use `deployments.fixture()` with no tags to match canonical main's
  // behavior — this triggers hardhat-deploy to run the full external
  // deploy chain (@keep-network/random-beacon, @keep-network/ecdsa)
  // so `WalletRegistry`, `ReimbursementPool`, etc. are deployed before
  // Bridge's deps resolve. Using a specific tag list (as the umbrella
  // does to skip FROST deploys for non-FROST tests) doesn't pull in
  // the external deploy chain via hardhat-deploy's tag resolution,
  // and the local `00_resolve_*` scripts then run before the external
  // deployers, aborting the fixture.
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

  const bridge: Bridge & BridgeStub = await helpers.contracts.getContract(
    "Bridge"
  )

  let tDeployment = await deployments.getOrNull("T")

  if (!tDeployment) {
    tDeployment = await deployments.deploy("T", {
      contract: "TestERC20",
      from: deployer.address,
      log: true,
      waitConfirmations: 1,
    })
  }

  const t: IERC20 = (await ethers.getContractAt(
    "TestERC20",
    tDeployment.address
  )) as IERC20

  if (!(await deployments.getOrNull("RebateStaking"))) {
    await helpers.upgrades.deployProxy("RebateStaking", {
      contractName: "RebateStaking",
      initializerArgs: [
        bridge.address,
        t.address,
        30 * 24 * 60 * 60, // 30 days rolling window
        30 * 24 * 60 * 60, // 30 days unstaking delay
        100000000, // 0.001 BTC fee rebate per 100000 T tokens staked
      ],
      factoryOpts: {
        signer: deployer,
      },
      proxyOpts: {
        kind: "transparent",
      },
    })
  }

  const rebateStaking: RebateStaking = await helpers.contracts.getContract(
    "RebateStaking"
  )

  const bridgeGovernance: BridgeGovernance =
    await helpers.contracts.getContract("BridgeGovernance")

  const bridgeGovernanceOwner = await bridgeGovernance.owner()
  if (
    bridgeGovernanceOwner.toLowerCase() !== governance.address.toLowerCase()
  ) {
    const bridgeGovernanceOwnerSigner =
      bridgeGovernanceOwner.toLowerCase() === deployer.address.toLowerCase()
        ? deployer
        : await ethers.getSigner(bridgeGovernanceOwner)

    await bridgeGovernance
      .connect(bridgeGovernanceOwnerSigner)
      .transferOwnership(governance.address)
  }

  const currentBridgeGovernance = await bridge.governance()
  if (
    currentBridgeGovernance.toLowerCase() !==
    bridgeGovernance.address.toLowerCase()
  ) {
    const currentBridgeGovernanceSigner =
      currentBridgeGovernance.toLowerCase() === deployer.address.toLowerCase()
        ? deployer
        : await ethers.getSigner(currentBridgeGovernance)

    await bridge
      .connect(currentBridgeGovernanceSigner)
      .transferGovernance(bridgeGovernance.address)
  }

  const walletRegistry = await smock.fake<IWalletRegistry>("IWalletRegistry", {
    address: await (await bridge.contractReferences()).ecdsaWalletRegistry,
  })
  // Ensure the fake contract address has ETH to pay gas when impersonated.
  // hardhat_setBalance expects an Ethereum JSON-RPC QUANTITY: the most
  // compact hex representation with no leading zeros (except `0x0`).
  // `BigNumber#toHexString()` pads to even length, which inserts a leading
  // zero for odd-nibble values (e.g. parseEther("100") -> 0x056bc75e2d63100000).
  // Hardhat's strict validator rejects that form, so strip the padding while
  // preserving the canonical zero form.
  const fundingBalance = (() => {
    const padded = ethers.utils.parseEther("100").toHexString()
    const stripped = padded.replace(/^0x0+/, "0x")
    return stripped === "0x" ? "0x0" : stripped
  })()
  await ethers.provider.send("hardhat_setBalance", [
    walletRegistry.address,
    fundingBalance,
  ])

  const reimbursementPool: ReimbursementPool =
    await helpers.contracts.getContract("ReimbursementPool")

  const maintainerProxy: MaintainerProxy = await helpers.contracts.getContract(
    "MaintainerProxy"
  )

  const relay = await smock.fake<IRelay>("IRelay", {
    address: await (await bridge.contractReferences()).relay,
  })

  const bankOwner = await bank.owner()
  let bankOwnerSigner: SignerWithAddress

  if (bankOwner.toLowerCase() === governance.address.toLowerCase()) {
    bankOwnerSigner = governance
  } else if (bankOwner.toLowerCase() === deployer.address.toLowerCase()) {
    bankOwnerSigner = deployer
  } else {
    bankOwnerSigner = await ethers.getSigner(bankOwner)
  }

  await bank.connect(bankOwnerSigner).updateBridge(bridge.address)

  const redemptionWatchtower: RedemptionWatchtower =
    await helpers.contracts.getContract("RedemptionWatchtower")

  // Deploy + wire the two fraud router sidecars. EcdsaFraudRouter
  // hosts the ECDSA fraud lifecycle (was inlined on Bridge);
  // P2TRSignatureFraudRouter is the sister sidecar for the P2TR
  // signature-fraud lifecycle. Both routers are pinned to the
  // Bridge address at construction and wired via the one-time
  // setters on Bridge.
  const existingEcdsaFraudRouter = await bridge.ecdsaFraudRouter()
  let ecdsaFraudRouter: EcdsaFraudRouter
  if (existingEcdsaFraudRouter === ethers.constants.AddressZero) {
    const EcdsaFraudRouterFactory = await ethers.getContractFactory(
      "EcdsaFraudRouter",
      deployer
    )
    ecdsaFraudRouter = (await EcdsaFraudRouterFactory.deploy(
      bridge.address
    )) as EcdsaFraudRouter
    await ecdsaFraudRouter.deployed()
    await bridgeGovernance
      .connect(governance)
      .setEcdsaFraudRouter(ecdsaFraudRouter.address)
  } else {
    ecdsaFraudRouter = (await ethers.getContractAt(
      "EcdsaFraudRouter",
      existingEcdsaFraudRouter
    )) as EcdsaFraudRouter
  }

  const existingP2TRFraudRouter = await bridge.p2trFraudRouter()
  let p2trFraudRouter: P2TRSignatureFraudRouter
  if (existingP2TRFraudRouter === ethers.constants.AddressZero) {
    const P2TRFraudRouterFactory = await ethers.getContractFactory(
      "P2TRSignatureFraudRouter",
      deployer
    )
    p2trFraudRouter = (await P2TRFraudRouterFactory.deploy(
      bridge.address
    )) as P2TRSignatureFraudRouter
    await p2trFraudRouter.deployed()
    await bridgeGovernance
      .connect(governance)
      .setP2TRFraudRouter(p2trFraudRouter.address)
  } else {
    p2trFraudRouter = (await ethers.getContractAt(
      "P2TRSignatureFraudRouter",
      existingP2TRFraudRouter
    )) as P2TRSignatureFraudRouter
  }

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
        unsafeAllow: ["external-library-linking"],
      },
    })

  // Enable economic slashing for the test suite. The contract default is off
  // (slashingActive=false); the existing fraud/timeout tests assert that `seize`
  // fires, so restore the pre-gate behavior here. Gate-off behavior (slashing
  // skipped, termination preserved) is covered by dedicated tests.
  await bridgeGovernance.connect(governance).setSlashingActive(true)

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
    ecdsaFraudRouter,
    p2trFraudRouter,
    deployBridge,
  }
}
