// Sepolia mainnet-style fork test for the combined Stage-3 Bridge
// upgrade. It performs the real upgrade against the live Sepolia proxy on a fork
// and proves BOTH preservation invariants and the new covenant defeat path:
//
//   1. Pre-upgrade live state matches the pinned baseline.
//   2. Live G1 `mintToBank` credits the Bank through the controller path BEFORE
//      the upgrade (records the Bank delta and controller event shape).
//   3. The registry, seven fresh libraries, and combined implementation deploy.
//   4. `ProxyAdmin.upgradeAndCall(initializeV6_Stage3Combined(...))` succeeds.
//   5. Raw storage slots 0-131 change ONLY as expected (slot 50 -> 6, slot 84 ->
//      wallet-order length, slot 129 -> open escrow (zero at baseline), slot 130
//      packs the seeded flags + registry); every other slot and a representative
//      set of mapping-backed/public getters are byte-for-byte identical, and
//      slot 81 (controller) is untouched.
//   6. Live G1 `mintToBank` credits the Bank with the SAME delta and event shape
//      AFTER the upgrade — the mandatory Stage-1/2 preservation proof.
//   7. G1 is impersonated and drives `controllerIncreaseBalances` directly.
//   8. A known-private-key wallet is registered on the fork; a covenant fraud
//      challenge is submitted, authorized, and defeated with
//      `defeatFraudChallengeWithCovenantSpend`; escrow is released to treasury
//      and the authorization is immutable; a mismatched tuple cannot defeat.
//
// Invocation (needs an archival Sepolia RPC):
//   FORKING_URL=<archive-sepolia-rpc> FORKING_BLOCK=11280610 \
//   TEST_USE_STUBS_TBTC=true \
//   yarn hardhat test test/bridge/Bridge.Stage3Combined.sepolia.fork.test.ts
//
// Without FORKING_URL the whole suite is skipped (describe.skip), so the file is
// still type-checked and loaded by the normal test run. Hardhat 2.12.5's fork
// provider additionally requires the upstream node to return the (deprecated)
// `totalDifficulty` block field; some archival providers omit it, which surfaces
// as `Invalid value undefined supplied to RpcBlockWithTransactions/
// totalDifficulty` at fork init. Use a provider that returns that field (or a
// Hardhat version that tolerates its absence) to run this suite live.

import hre, { ethers } from "hardhat"
import { expect } from "chai"
import { BigNumber, Signer } from "ethers"
import { SigningKey } from "ethers/lib/utils"

const { keccak256, sha256 } = ethers.utils

// ---- Pinned live Sepolia values ----
const FORK_BLOCK = 11280610
const BRIDGE_PROXY = "0x9b1a7fE5a16A15F2f9475C5B231750598b113403"
const OLD_IMPL = "0xa14a9607DeDE925C7f7aCfB27Ce192771F8F6FA0"
const PROXY_ADMIN = "0x39f60B25C4598Caf7e922d6fC063E9002db45845"
const PROXY_ADMIN_OWNER = "0x68ad60CC5e8f3B7cC53beaB321cf0e6036962dBc"
const G1 = "0x1433e4f7a1FD121a0988d12A2323Bb95E2D54A0E"
const G1_OPERATOR = "0x15Ba3A71725BF497D9D14a0b0B18688eC7326cd9"
const BANK = "0x4918fD33a22e7E2948B7444CbDd68efAa9E6a087"
// Live active wallet at the pinned block (lowercase; compared case-insensitively).
const ACTIVE_WALLET = "0xef5a2946f294f1742a779c9ac034bc3fa5d417b8"
const BRIDGE_DEPLOY_BLOCK = 4553028
const IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
const ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"

// Absolute Bridge storage slots snapshotted before/after the upgrade: 0..131.
const SLOT_COUNT = 132

// ---- Pinned live Sepolia entries at FORK_BLOCK for the storage-preservation
// proof. Each pinned mapping entry below is a REAL, populated (non-default)
// entry read from the live chain at block 11280610; the snapshot's scalar
// samples are also live except rebate staking, which is (correctly) unset at
// this block. Snapshotting them before AND after the upgrade proves the
// combined implementation does not reinterpret any preserved mapping storage
// (raw mapping-root slots 0..131 are always zero and cannot show this). ----
// A revealed, still-unswept deposit. Key =
// keccak256(fundingTxHash ++ uint32(fundingOutputIndex)); reads to a record with
// a nonzero `revealedAt`.
const SAMPLE_DEPOSIT_KEY =
  "0x7870b687471b01eeed00dbe80d5acaab36c2dcf69e4c7459794378e0b6c9c0cb"
// A redemption still pending at the fork block. Key =
// keccak256(keccak256(redeemerOutputScript) ++ walletPubKeyHash); reads to a
// record with a nonzero `requestedAt`.
const SAMPLE_REDEMPTION_KEY =
  "0x02d908230c7f98114d1905b6319fa48cf1186ce22ef31ce277fc16864ebcbf4f"
// A moved-funds sweep request. Key =
// keccak256(movingFundsTxHash ++ uint32(outputIndex)); reads to a record with a
// nonzero `createdAt`.
const SAMPLE_SWEEP_KEY =
  "0x6a7d002628af07d86c04de78d45794f8254731acbd4180857cb163f3f2cbc22d"
// A vault trusted by the Bridge at the fork block (the live Sepolia TBTCVault).
const SAMPLE_TRUSTED_VAULT = "0xb5679de944a79732a75ce556191df11f489448d5"
// A trusted SPV maintainer at the fork block. `isSpvMaintainer` has no public
// getter, so its entry is read directly from the derived mapping slot.
// `isSpvMaintainer` is the Bridge storage struct's relative slot 21, and the
// struct begins at absolute slot 51 (the SAME base that puts `mintingController`
// at absolute slot 81 — see BridgeState.sol). Its mapping root is therefore
// absolute slot 72, verified against the live chain where this maintainer's
// derived slot reads 1 while a since-revoked maintainer's derived slot reads 0.
const SAMPLE_SPV_MAINTAINER = "0x3bc9a80a3ed44a9d14162992cce040efac5a3682"
const SPV_MAINTAINER_ROOT_SLOT = 72
const SPV_MAINTAINER_SLOT = ethers.utils.keccak256(
  ethers.utils.defaultAbiCoder.encode(
    ["address", "uint256"],
    [SAMPLE_SPV_MAINTAINER, SPV_MAINTAINER_ROOT_SLOT]
  )
)

const BRIDGE_LIBRARIES = [
  "Deposit",
  "DepositSweep",
  "Redemption",
  "contracts/bridge/Wallets.sol:Wallets",
  "Fraud",
  "MovingFunds",
  "VaultManagement",
]

const forkAvailable = !!process.env.FORKING_URL
const describeFork = forkAvailable ? describe : describe.skip

// Impersonates and funds `address`, returning its signer.
async function impersonate(address: string): Promise<Signer> {
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [address],
  })
  await hre.network.provider.send("hardhat_setBalance", [
    address,
    "0x3635C9ADC5DEA00000", // 1000 ETH
  ])
  return ethers.provider.getSigner(address)
}

const addressFromSlot = (word: string) =>
  ethers.utils.getAddress(`0x${word.slice(-40)}`)

// Canonically checksums an all-lowercase vanity address so both the call and the
// event-argument assertion use the exact string ethers decodes logs into.
const addr = (lower: string) => ethers.utils.getAddress(lower)

describeFork("Bridge - Stage-3 combined upgrade (Sepolia fork)", function () {
  this.timeout(Number(process.env.FORK_TEST_TIMEOUT_MS) || 1800000)

  let proxyAdminOwner: Signer
  let g1Operator: Signer
  let deployer: Signer
  let bridge: any
  // Full-ABI reader bound to the same proxy, used for representative public /
  // mapping-backed state getters (avoids hand-maintaining every return tuple).
  let bridgeReader: any
  let g1: any
  let bank: any
  let registry: any
  let newImplAddress: string
  let treasury: string
  let walletRegistry: string
  // Event-scan wallet order (oldest first); hoisted so the slot-comparison test
  // can assert slot 84 equals its length.
  let walletOrder: string[]
  // Raw slots 0-131 and representative state, captured before/after the upgrade.
  let preSlots: string[]
  let postSlots: string[]
  let preState: Record<string, unknown>
  let postState: Record<string, unknown>

  const bridgeAbi = [
    "function governance() view returns (address)",
    "function mintingController() view returns (address)",
    "function getMintingController() view returns (address)",
    "function migrationDebtVault() view returns (address)",
    "function activeWalletPubKeyHash() view returns (bytes20)",
    "function treasury() view returns (address)",
    "function contractReferences() view returns (address,address,address,address)",
    "function fraudParameters() view returns (uint96,uint32,uint96,uint32)",
    "function controllerIncreaseBalances(address[] recipients, uint256[] amounts)",
    "function fraudChallenges(uint256) view returns (uint32,bool,uint96)",
    // The on-chain signature struct is BitcoinTx.RSVSignature = (r, s, v); the
    // tuple order here MUST match it or the encoded calldata mis-maps r/s/v.
    "function submitFraudChallenge(bytes walletPublicKey, bytes preimageSha256, (bytes32 r, bytes32 s, uint8 v) signature) payable",
    "function defeatFraudChallengeWithCovenantSpend(bytes walletPublicKey, bytes preimage)",
    "function __ecdsaWalletCreatedCallback(bytes32 ecdsaWalletID, bytes32 publicKeyX, bytes32 publicKeyY)",
    "event ControllerBalanceIncreased(address indexed controller, address indexed recipient, uint256 amount)",
    "event ControllerBalancesIncreased(address indexed controller, address[] recipients, uint256[] amounts)",
    "event CovenantSpendAuthorizationUpdated(address indexed covenantSpendAuthorization)",
    "event FraudChallengeDefeated(bytes20 indexed walletPubKeyHash, bytes32 sighash)",
    // Indexed bytes20 topics are LEFT-aligned; decode via the ABI, never by
    // slicing the last 20 bytes of the 32-byte topic word.
    "event NewWalletRegistered(bytes32 indexed ecdsaWalletID, bytes20 indexed walletPubKeyHash)",
    "function initializeV6_Stage3Combined(address expectedMintingController, address covenantSpendAuthorization_, uint256 preUpgradeOpenFraudChallengeEscrow, bytes20[] preUpgradeWallets)",
  ]
  const g1Abi = [
    "function mintToBank(address recipient, uint256 amount)",
    "function totalMinted() view returns (uint256)",
    "function operator() view returns (address)",
  ]
  const bankAbi = ["function balanceOf(address) view returns (uint256)"]
  const proxyAdminAbi = [
    "function upgradeAndCall(address proxy, address implementation, bytes data) payable",
  ]

  // Reads raw absolute Bridge slots 0..SLOT_COUNT-1.
  const snapshotSlots = async (): Promise<string[]> => {
    const slots: string[] = []
    // eslint-disable-next-line no-plusplus
    for (let i = 0; i < SLOT_COUNT; i++) {
      // eslint-disable-next-line no-await-in-loop
      slots.push(await ethers.provider.getStorageAt(BRIDGE_PROXY, i))
    }
    return slots
  }

  // Reads a representative sample of the Bridge's mapping-backed/public state so
  // the upgrade can be proven not to reinterpret any preserved storage.
  const snapshotState = async (): Promise<Record<string, unknown>> => ({
    references: (await bridgeReader.contractReferences()).map(String),
    treasury: await bridgeReader.treasury(),
    governance: await bridgeReader.governance(),
    activeWallet: await bridgeReader.activeWalletPubKeyHash(),
    liveWalletsCount: (await bridgeReader.liveWalletsCount()).toString(),
    fraudParameters: (await bridgeReader.fraudParameters()).map(String),
    depositParameters: (await bridgeReader.depositParameters()).map(String),
    redemptionParameters: (await bridgeReader.redemptionParameters()).map(
      String
    ),
    movingFundsParameters: (await bridgeReader.movingFundsParameters()).map(
      String
    ),
    walletParameters: (await bridgeReader.walletParameters()).map(String),
    // At least one historical wallet: the active wallet's full record.
    activeWalletRecord: [...(await bridgeReader.wallets(ACTIVE_WALLET))].map(
      String
    ),
    // Populated mapping-backed entries (real live keys at the fork block) that
    // must survive the upgrade byte-for-byte through their existing mapping roots.
    sampleDeposit: [...(await bridgeReader.deposits(SAMPLE_DEPOSIT_KEY))].map(
      String
    ),
    samplePendingRedemption: [
      ...(await bridgeReader.pendingRedemptions(SAMPLE_REDEMPTION_KEY)),
    ].map(String),
    sampleMovedFundsSweep: [
      ...(await bridgeReader.movedFundsSweepRequests(SAMPLE_SWEEP_KEY)),
    ].map(String),
    sampleTrustedVault: await bridgeReader.isVaultTrusted(SAMPLE_TRUSTED_VAULT),
    // `isSpvMaintainer` has no getter — read the derived mapping slot directly.
    sampleSpvMaintainerSlot: await ethers.provider.getStorageAt(
      BRIDGE_PROXY,
      SPV_MAINTAINER_SLOT
    ),
    // Scalar getters that live just below the migration-owned slots. The
    // watchtower is a real nonzero address; rebate staking is (correctly) unset
    // at the fork block and must stay unset — a nonzero post-upgrade read would
    // signal a layout regression around the reconstructed fields.
    redemptionWatchtower: await bridgeReader.getRedemptionWatchtower(),
    rebateStaking: await bridgeReader.getRebateStaking(),
  })

  before(async function () {
    const bn = await ethers.provider.getBlockNumber()
    if (bn < FORK_BLOCK) this.skip()
    // The pinned live-state samples (deposit/redemption/sweep/vault/maintainer
    // keys) are only valid at exactly FORK_BLOCK; a fork at any other height
    // would read different — or since-removed — entries, so require the exact
    // pinned block rather than merely "at least" it.
    expect(bn).to.equal(FORK_BLOCK)

    proxyAdminOwner = await impersonate(PROXY_ADMIN_OWNER)
    g1Operator = await impersonate(G1_OPERATOR)
    const [firstSigner] = await ethers.getSigners()
    deployer = firstSigner

    bridge = new ethers.Contract(BRIDGE_PROXY, bridgeAbi, deployer)
    bridgeReader = await ethers.getContractAt("Bridge", BRIDGE_PROXY, deployer)
    g1 = new ethers.Contract(G1, g1Abi, deployer)
    bank = new ethers.Contract(BANK, bankAbi, deployer)

    treasury = await bridge.treasury()
    const refs = await bridge.contractReferences()
    // eslint-disable-next-line prefer-destructuring
    walletRegistry = refs[2] // ecdsaWalletRegistry
  })

  it("confirms the pinned pre-upgrade implementation/admin/controller state", async () => {
    expect(
      addressFromSlot(
        await ethers.provider.getStorageAt(BRIDGE_PROXY, IMPL_SLOT)
      )
    ).to.equal(OLD_IMPL)
    expect(
      addressFromSlot(
        await ethers.provider.getStorageAt(BRIDGE_PROXY, ADMIN_SLOT)
      )
    ).to.equal(PROXY_ADMIN)
    expect(await bridge.mintingController()).to.equal(G1)
    expect(await bridge.getMintingController()).to.equal(G1)
    // Initializer version 5 (low byte of slot 50).
    const v = await ethers.provider.getStorageAt(BRIDGE_PROXY, 50)
    expect(parseInt(v.slice(-2), 16)).to.equal(5)
  })

  let preBankDelta: BigNumber

  it("credits the Bank via live G1 mintToBank BEFORE the upgrade", async () => {
    const recipient = addr("0x000000000000000000000000000000000000c0de")
    const before = await bank.balanceOf(recipient)
    const mintedBefore = await g1.totalMinted()
    const tx = await g1.connect(g1Operator).mintToBank(recipient, 10)
    await tx.wait()
    preBankDelta = (await bank.balanceOf(recipient)).sub(before)
    expect(preBankDelta).to.be.gt(0)
    // The Bridge attributes a ControllerBalanceIncreased log from G1.
    await expect(tx)
      .to.emit(bridge, "ControllerBalanceIncreased")
      .withArgs(G1, recipient, preBankDelta)
    expect((await g1.totalMinted()).sub(mintedBefore)).to.be.gt(0)
  })

  it("deploys the registry, seven fresh libraries, and combined implementation, then upgrades", async () => {
    // Registry (deployer is owner; it will authorize covenant spends below).
    const RegistryFactory = await ethers.getContractFactory(
      "CovenantSpendAuthorization",
      deployer
    )
    registry = await RegistryFactory.deploy()
    await registry.deployed()

    // Seven fresh libraries linked into the combined implementation.
    const libraries: Record<string, string> = {}
    // eslint-disable-next-line no-restricted-syntax
    for (const lib of BRIDGE_LIBRARIES) {
      // eslint-disable-next-line no-await-in-loop
      const factory = await ethers.getContractFactory(lib, deployer)
      // eslint-disable-next-line no-await-in-loop
      const deployed = await factory.deploy()
      // eslint-disable-next-line no-await-in-loop
      await deployed.deployed()
      const key = lib.includes(":") ? lib.split(":")[1] : lib
      libraries[key] = deployed.address
    }
    const BridgeFactory = await ethers.getContractFactory("Bridge", {
      libraries,
      signer: deployer,
    })
    const impl = await BridgeFactory.deploy()
    await impl.deployed()
    newImplAddress = impl.address
    // The combined runtime must fit under EIP-170.
    const runtime = await ethers.provider.getCode(newImplAddress)
    expect((runtime.length - 2) / 2).to.be.lessThan(24576)

    // Scan the pre-upgrade wallet registration order (oldest first). The
    // walletPubKeyHash topic is an indexed bytes20, so it must be decoded with
    // the event ABI (left-aligned) rather than by slicing raw topic bytes.
    const iface = new ethers.utils.Interface(bridgeAbi)
    const topic = iface.getEventTopic("NewWalletRegistered")
    const logs = await ethers.provider.getLogs({
      address: BRIDGE_PROXY,
      topics: [topic],
      fromBlock: BRIDGE_DEPLOY_BLOCK,
      toBlock: FORK_BLOCK,
    })
    logs.sort((a, b) =>
      a.blockNumber !== b.blockNumber
        ? a.blockNumber - b.blockNumber
        : a.logIndex - b.logIndex
    )
    walletOrder = logs.map(
      (l) => iface.parseLog(l).args.walletPubKeyHash as string
    )
    expect(walletOrder[walletOrder.length - 1].toLowerCase()).to.equal(
      ACTIVE_WALLET
    )
    // At the pinned baseline the Bridge holds no ETH, so open escrow is zero.
    const openEscrow = await ethers.provider.getBalance(BRIDGE_PROXY)
    expect(openEscrow).to.equal(0)

    // Snapshot raw slots + representative state immediately before the upgrade.
    preSlots = await snapshotSlots()
    preState = await snapshotState()

    const initializerCalldata = iface.encodeFunctionData(
      "initializeV6_Stage3Combined",
      [G1, registry.address, openEscrow, walletOrder]
    )
    const proxyAdmin = new ethers.Contract(
      PROXY_ADMIN,
      proxyAdminAbi,
      proxyAdminOwner
    )
    const tx = await proxyAdmin.upgradeAndCall(
      BRIDGE_PROXY,
      newImplAddress,
      initializerCalldata
    )
    await expect(tx)
      .to.emit(bridge, "CovenantSpendAuthorizationUpdated")
      .withArgs(registry.address)
  })

  it("changes only the expected storage slots and preserves controller slot 81 and representative state", async () => {
    postSlots = await snapshotSlots()
    postState = await snapshotState()

    // Every slot 0-131 must be identical across the upgrade except the four
    // migration-owned slots. Slot 129 (open escrow) is allowed to change but is
    // zero at the pinned baseline; it is asserted explicitly below.
    const allowedToChange = new Set([50, 84, 129, 130])
    // eslint-disable-next-line no-plusplus
    for (let i = 0; i < SLOT_COUNT; i++) {
      if (allowedToChange.has(i)) {
        // eslint-disable-next-line no-continue
        continue
      }
      expect(postSlots[i], `slot ${i} changed unexpectedly`).to.equal(
        preSlots[i]
      )
    }

    // Slot 50: OpenZeppelin initializer version. Assert the FULL 32-byte word
    // (not merely the low byte): exactly 5 before and 6 after, so a stray write
    // to any higher byte of the initializer word (e.g. a lingering `_initializing`
    // flag) is caught.
    expect(preSlots[50]).to.equal(ethers.utils.hexZeroPad("0x05", 32))
    expect(postSlots[50]).to.equal(ethers.utils.hexZeroPad("0x06", 32))
    // Slot 84: walletRegistrationOrder array length 0 -> event-scan count.
    expect(BigNumber.from(preSlots[84])).to.equal(0)
    expect(BigNumber.from(postSlots[84])).to.equal(walletOrder.length)
    // Slot 129: openFraudChallengeEscrow; zero before and after at the baseline.
    expect(BigNumber.from(preSlots[129])).to.equal(0)
    expect(BigNumber.from(postSlots[129])).to.equal(0)
    // Slot 130: packs fraudChallengeEscrowSeeded (bit 0) +
    // walletRegistrationOrderSeeded (bit 8) + covenant registry (>> 16).
    const expected130 = BigNumber.from(registry.address).shl(16).or(0x0101)
    expect(BigNumber.from(preSlots[130])).to.equal(0)
    expect(BigNumber.from(postSlots[130])).to.equal(expected130)

    // EIP-1967 impl/admin slots (outside 0-131).
    expect(
      addressFromSlot(
        await ethers.provider.getStorageAt(BRIDGE_PROXY, IMPL_SLOT)
      )
    ).to.equal(newImplAddress)
    expect(
      addressFromSlot(
        await ethers.provider.getStorageAt(BRIDGE_PROXY, ADMIN_SLOT)
      )
    ).to.equal(PROXY_ADMIN)
    // Slot 81 (controller) unchanged and migrationDebtVault still zero.
    expect(
      addressFromSlot(await ethers.provider.getStorageAt(BRIDGE_PROXY, 81))
    ).to.equal(G1)
    expect(await bridge.mintingController()).to.equal(G1)
    expect(await bridge.migrationDebtVault()).to.equal(
      ethers.constants.AddressZero
    )

    // The representative samples must be real, populated (non-default) entries at
    // the fork block; otherwise the byte-for-byte equality below would prove only
    // that zero-valued mapping defaults survive. Assert each is nonzero BEFORE the
    // upgrade so the preservation proof genuinely exercises populated storage.
    expect(
      (preState.sampleDeposit as string[])[2],
      "sample deposit revealedAt must be populated"
    ).to.not.equal("0")
    expect(
      (preState.samplePendingRedemption as string[])[4],
      "sample redemption requestedAt must be populated"
    ).to.not.equal("0")
    expect(
      (preState.sampleMovedFundsSweep as string[])[2],
      "sample moved-funds sweep createdAt must be populated"
    ).to.not.equal("0")
    expect(
      preState.sampleTrustedVault,
      "sample vault must be trusted"
    ).to.equal(true)
    expect(
      BigNumber.from(preState.sampleSpvMaintainerSlot as string),
      "sample SPV maintainer slot must be set"
    ).to.equal(1)
    expect(
      preState.redemptionWatchtower,
      "redemption watchtower must be set"
    ).to.not.equal(ethers.constants.AddressZero)

    // Representative mapping-backed/public state is byte-for-byte identical.
    expect(postState).to.deep.equal(preState)
  })

  it("credits the Bank via live G1 mintToBank AFTER the upgrade with the same delta and event", async () => {
    // Different recipient; same amount => the controller path is preserved.
    const recipient = addr("0x000000000000000000000000000000000000beef")
    const before = await bank.balanceOf(recipient)
    const tx = await g1.connect(g1Operator).mintToBank(recipient, 10)
    await tx.wait()
    const delta = (await bank.balanceOf(recipient)).sub(before)
    expect(delta).to.equal(preBankDelta)
    await expect(tx)
      .to.emit(bridge, "ControllerBalanceIncreased")
      .withArgs(G1, recipient, delta)
  })

  it("lets the controller drive controllerIncreaseBalances directly after upgrade", async () => {
    const g1Signer = await impersonate(G1)
    const r1 = addr("0x0000000000000000000000000000000000000aa1")
    const r2 = addr("0x0000000000000000000000000000000000000aa2")
    const b1 = await bank.balanceOf(r1)
    const b2 = await bank.balanceOf(r2)
    const tx = await bridge
      .connect(g1Signer)
      .controllerIncreaseBalances([r1, r2], [3, 5])
    await expect(tx)
      .to.emit(bridge, "ControllerBalancesIncreased")
      .withArgs(G1, [r1, r2], [3, 5])
    expect((await bank.balanceOf(r1)).sub(b1)).to.equal(3)
    expect((await bank.balanceOf(r2)).sub(b2)).to.equal(5)
  })

  // ---- Covenant defeat path (Stage-3 feature), mirroring Bridge.Frauds.test.ts ----
  describe("covenant spend fraud defeat", () => {
    let covenantWalletSigningKey: SigningKey
    let covenantWalletPublicKey: string
    let covenantWalletPubKeyHash: string
    let fraudChallengeDepositAmount: BigNumber

    const strip = (hex: string) => (hex.startsWith("0x") ? hex.slice(2) : hex)
    const leUint64 = (value: number) => {
      const be = BigNumber.from(value).toHexString().slice(2).padStart(16, "0")
      return be.match(/../g)!.reverse().join("")
    }
    const scenario = {
      outpointTxHash: sha256("0xbeadfeed"),
      value: 5000,
      outputsHash: sha256("0xc0ffee01"),
    }
    const buildPreimage = (s = scenario) =>
      `0x${[
        "01000000",
        strip(sha256("0xa1")),
        strip(sha256("0xa2")),
        strip(s.outpointTxHash),
        "00000000",
        "03aabbcc",
        leUint64(s.value),
        "ffffffff",
        strip(s.outputsHash),
        "00000000",
        "01000000",
      ].join("")}`

    before(async () => {
      const [depositAmount] = await bridge.fraudParameters()
      fraudChallengeDepositAmount = depositAmount

      // Register a known-private-key wallet by impersonating the real
      // WalletRegistry and calling the Bridge's ECDSA wallet callback.
      const registrySigner = await impersonate(walletRegistry)
      const randomWallet = ethers.Wallet.createRandom()
      covenantWalletSigningKey = new ethers.utils.SigningKey(
        randomWallet.privateKey
      )
      covenantWalletPublicKey = `0x${randomWallet.publicKey.substring(4)}`
      const walletID = keccak256(covenantWalletPublicKey)
      const x = `0x${covenantWalletPublicKey.substring(2, 66)}`
      const y = `0x${covenantWalletPublicKey.substring(66)}`
      await bridge
        .connect(registrySigner)
        .__ecdsaWalletCreatedCallback(walletID, x, y)
      covenantWalletPubKeyHash = await bridge.activeWalletPubKeyHash()
    })

    const submitChallenge = async (preimage: string) => {
      const sighash = sha256(sha256(preimage))
      const signature = ethers.utils.splitSignature(
        covenantWalletSigningKey.signDigest(sighash)
      )
      const challenger = (await ethers.getSigners())[1]
      await bridge
        .connect(challenger)
        .submitFraudChallenge(
          covenantWalletPublicKey,
          sha256(preimage),
          signature,
          { value: fraudChallengeDepositAmount }
        )
      return sighash
    }

    it("defeats a covenant fraud challenge and releases escrow to treasury", async () => {
      const sighash = await submitChallenge(buildPreimage())
      // Authorize the exact (outpoint, wallet, value, outputsHash) tuple.
      await registry.authorizeCovenantSpend(
        scenario.outpointTxHash,
        0,
        covenantWalletPubKeyHash,
        scenario.value,
        scenario.outputsHash
      )

      // Escrow is released to the treasury on a successful covenant defeat.
      const treasuryBefore = await ethers.provider.getBalance(treasury)
      const tx = await bridge
        .connect((await ethers.getSigners())[1])
        .defeatFraudChallengeWithCovenantSpend(
          covenantWalletPublicKey,
          buildPreimage()
        )
      await tx.wait()
      await expect(tx)
        .to.emit(bridge, "FraudChallengeDefeated")
        .withArgs(covenantWalletPubKeyHash, sighash)
      const treasuryAfter = await ethers.provider.getBalance(treasury)
      expect(treasuryAfter.sub(treasuryBefore)).to.equal(
        fraudChallengeDepositAmount
      )
      // The authorization is immutable: re-authorizing the same outpoint reverts.
      await expect(
        registry.authorizeCovenantSpend(
          scenario.outpointTxHash,
          0,
          covenantWalletPubKeyHash,
          scenario.value,
          scenario.outputsHash
        )
      ).to.be.revertedWith("Covenant spend already authorized")
    })

    it("cannot defeat a challenge with a mismatched (unauthorized) tuple", async () => {
      const other = {
        outpointTxHash: sha256("0xdeadbead"),
        value: 7000,
        outputsHash: sha256("0xc0ffee02"),
      }
      await submitChallenge(buildPreimage(other))
      // No authorization for `other` => defeat must revert.
      await expect(
        bridge
          .connect((await ethers.getSigners())[1])
          .defeatFraudChallengeWithCovenantSpend(
            covenantWalletPublicKey,
            buildPreimage(other)
          )
      ).to.be.revertedWith("Covenant spend not authorized")
    })
  })
})
