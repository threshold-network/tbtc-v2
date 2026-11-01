import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { setStorageAt } from "@nomicfoundation/hardhat-network-helpers"

import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import type { BaseContract } from "ethers"
import type {
  Bank,
  Bridge,
  BridgeStub,
  IRelay,
  IWalletRegistry,
  ReimbursementPool,
  RebateStaking,
} from "../../typechain"

import bridgeFixture from "../fixtures/bridge"
// The committed layout snapshot is what `Bridge.StorageLayout.test.ts` pins to
// the compiled layout, so the slots read from it are the real ones.
import bridgeStateStorageSnapshot from "../fixtures/BridgeState.storageLayout.snapshot.json"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { ZeroAddress } = ethers

describe("Bridge - initializers", () => {
  let deployer: HardhatEthersSigner
  let governance: HardhatEthersSigner
  let treasury: HardhatEthersSigner
  let thirdParty: HardhatEthersSigner
  let bank: Bank
  let relay: { address: string }
  let walletRegistry: { address: string }
  let reimbursementPool: ReimbursementPool
  let rebateStaking: RebateStaking
  let deployBridge: (
    txProofDifficultyFactor: number
  ) => Promise<[Bridge & BridgeStub]>

  before(async () => {
    ;({
      deployer,
      governance,
      treasury,
      thirdParty,
      bank,
      relay,
      walletRegistry,
      reimbursementPool,
      rebateStaking,
      deployBridge,
    } = await bridgeFixture())
  })

  describe("initialize", () => {
    type InitializeArgs = [
      string,
      string,
      string,
      string,
      string,
      number | bigint,
    ]

    const validArgs = (): InitializeArgs => [
      bank.target as string,
      (relay as unknown as IRelay & { address: string }).address,
      treasury.address,
      (walletRegistry as unknown as IWalletRegistry & { address: string })
        .address,
      reimbursementPool.target as string,
      1,
    ]

    // Deploys a fresh Bridge proxy running `initialize` with the given
    // arguments in the proxy constructor, so a failing `require` surfaces as
    // a failed deployment.
    const deployProxy = async (args: InitializeArgs) => {
      const bridgeFactory = await ethers.getContractFactory("BridgeStub", {
        signer: deployer,
        libraries: {
          Deposit: (await helpers.contracts.getContract("Deposit")).target,
          DepositSweep: (await helpers.contracts.getContract("DepositSweep"))
            .target,
          Redemption: (await helpers.contracts.getContract("Redemption"))
            .target,
          Wallets: (await helpers.contracts.getContract("Wallets")).target,
          Fraud: (await helpers.contracts.getContract("Fraud")).target,
          MovingFunds: (await helpers.contracts.getContract("MovingFunds"))
            .target,
        },
      })
      const implementation = await bridgeFactory.deploy()
      await implementation.waitForDeployment()

      const proxyFactory = await ethers.getContractFactory(
        "TransparentUpgradeableProxy",
        deployer
      )
      return proxyFactory.deploy(
        implementation.target,
        governance.address,
        bridgeFactory.interface.encodeFunctionData("initialize", args)
      ) as Promise<BaseContract>
    }

    context("when all addresses are non-zero", () => {
      let proxy: BaseContract

      before(async () => {
        await createSnapshot()
        proxy = await deployProxy(validArgs())
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should initialize the Bridge", async () => {
        const initialized = await ethers.getContractAt("Bridge", proxy.target)

        const references = await initialized.contractReferences()
        expect(references.bank).to.equal(bank.target)
        expect(references.reimbursementPool).to.equal(reimbursementPool.target)
        expect(await initialized.txProofDifficultyFactor()).to.equal(1)
      })
    })

    const zeroCases: {
      name: string
      index: number
      reason: string
    }[] = [
      { name: "bank", index: 0, reason: "Bank address cannot be zero" },
      { name: "relay", index: 1, reason: "Relay address cannot be zero" },
      {
        name: "treasury",
        index: 2,
        reason: "Treasury address cannot be zero",
      },
      {
        name: "ECDSA wallet registry",
        index: 3,
        reason: "ECDSA Wallet Registry address cannot be zero",
      },
      {
        name: "reimbursement pool",
        index: 4,
        reason: "Reimbursement Pool address cannot be zero",
      },
    ]

    zeroCases.forEach(({ name, index, reason }) => {
      context(`when the ${name} address is zero`, () => {
        it("should revert", async () => {
          const args = validArgs()
          args[index] = ZeroAddress

          await expect(deployProxy(args)).to.be.revertedWith(reason)
        })
      })
    })
  })

  describe("initializeV5_RepairRebateStaking", () => {
    // `reinitializer(5)` has no access control: it can be called on a proxy
    // that has only run `initialize`, which is how a fresh Bridge is used here.
    let freshBridge: Bridge & BridgeStub

    beforeEach(async () => {
      await createSnapshot()
      ;[freshBridge] = await deployBridge(1)
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    context("when the new address equals the current one", () => {
      it("should revert", async () => {
        expect(await freshBridge.getRebateStaking()).to.equal(ZeroAddress)

        await expect(
          freshBridge.initializeV5_RepairRebateStaking(ZeroAddress)
        ).to.be.revertedWith("Rebate staking unchanged")
      })
    })

    context("when the new address is not a contract", () => {
      it("should revert", async () => {
        await expect(
          freshBridge.initializeV5_RepairRebateStaking(thirdParty.address)
        ).to.be.revertedWith("Rebate staking must be a contract")
      })
    })

    context("when the new address is a contract", () => {
      it("should set the rebate staking address and emit the event", async () => {
        await expect(
          freshBridge.initializeV5_RepairRebateStaking(rebateStaking.target)
        )
          .to.emit(freshBridge, "RebateStakingRepaired")
          .withArgs(ZeroAddress, rebateStaking.target)

        expect(await freshBridge.getRebateStaking()).to.equal(
          rebateStaking.target
        )
      })

      it("should not be callable a second time", async () => {
        await freshBridge.initializeV5_RepairRebateStaking(rebateStaking.target)

        await expect(
          freshBridge.initializeV5_RepairRebateStaking(ZeroAddress)
        ).to.be.revertedWith("Initializable: contract is already initialized")
      })
    })
  })

  describe("initializeV2_FixVaultZeroDeposit", () => {
    // The deposit the upgrade repairs, as hard-coded in the contract.
    const depositKey =
      0xf3bc9cd6f46f4c206bc8711e40bb5692e8fe5f0ac4d4da0a709dc71bb751c98an
    const tbtcVault = "0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD"
    const depositor = "0xe7c9a5298A2d2e48B5df3F9D361BA1469B0f436B"
    const amount = 1_000_000n
    const revealedAt = 1_767_830_400n
    const treasuryFee = 500n
    const sweptAt = 1_768_000_000n

    let freshBridge: Bridge & BridgeStub

    // Writes `deposits[depositKey]` straight into storage. The key is fixed
    // by the contract, so the deposit cannot be produced by a real reveal.
    // Slot 0 packs depositor | amount | revealedAt, slot 1 packs
    // vault | treasuryFee | sweptAt.
    const writeDeposit = async (deposit: {
      vault: string
      sweptAt: bigint
    }) => {
      const depositsMember = bridgeStateStorageSnapshot.members.find(
        (member) => member.label === "deposits"
      )
      if (!depositsMember) {
        throw new Error("deposits member not found in the layout snapshot")
      }
      const mappingSlot =
        BigInt(bridgeStateStorageSnapshot.self.slot) +
        BigInt(depositsMember.slot)
      const entrySlot = BigInt(
        ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["uint256", "uint256"],
            [depositKey, mappingSlot]
          )
        )
      )

      const slot0 = ethers.solidityPacked(
        ["uint32", "uint64", "address"],
        [revealedAt, amount, depositor]
      )
      const slot1 = ethers.solidityPacked(
        ["uint32", "uint64", "address"],
        [deposit.sweptAt, treasuryFee, deposit.vault]
      )

      await setStorageAt(freshBridge.target as string, entrySlot, slot0)
      await setStorageAt(freshBridge.target as string, entrySlot + 1n, slot1)
    }

    beforeEach(async () => {
      await createSnapshot()
      ;[freshBridge] = await deployBridge(1)
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    context("when the deposit was never revealed", () => {
      it("should revert", async () => {
        await expect(
          freshBridge.initializeV2_FixVaultZeroDeposit()
        ).to.be.revertedWith("Deposit not revealed")
      })
    })

    context("when the deposit already has a vault", () => {
      it("should revert", async () => {
        await writeDeposit({ vault: thirdParty.address, sweptAt: 0n })

        await expect(
          freshBridge.initializeV2_FixVaultZeroDeposit()
        ).to.be.revertedWith("Vault already set")
      })
    })

    context("when the deposit was already swept", () => {
      it("should revert", async () => {
        await writeDeposit({ vault: ZeroAddress, sweptAt })

        await expect(
          freshBridge.initializeV2_FixVaultZeroDeposit()
        ).to.be.revertedWith("Deposit already swept")
      })
    })

    context("when the deposit is revealed, vault-less and not swept", () => {
      beforeEach(async () => {
        await writeDeposit({ vault: ZeroAddress, sweptAt: 0n })
      })

      it("should see the written deposit before the fix", async () => {
        // Guards the storage write itself: if the layout moved, this fails
        // instead of the tests above passing for the wrong reason.
        const deposit = await freshBridge.deposits(depositKey)
        expect(deposit.depositor).to.equal(depositor)
        expect(deposit.amount).to.equal(amount)
        expect(deposit.revealedAt).to.equal(revealedAt)
        expect(deposit.vault).to.equal(ZeroAddress)
        expect(deposit.treasuryFee).to.equal(treasuryFee)
        expect(deposit.sweptAt).to.equal(0)
      })

      it("should route the deposit to the TBTC vault and emit the event", async () => {
        await expect(freshBridge.initializeV2_FixVaultZeroDeposit())
          .to.emit(freshBridge, "DepositVaultFixed")
          .withArgs(depositKey, tbtcVault)

        const deposit = await freshBridge.deposits(depositKey)
        expect(deposit.vault).to.equal(tbtcVault)
        // Nothing else about the deposit changes.
        expect(deposit.depositor).to.equal(depositor)
        expect(deposit.amount).to.equal(amount)
        expect(deposit.revealedAt).to.equal(revealedAt)
        expect(deposit.treasuryFee).to.equal(treasuryFee)
        expect(deposit.sweptAt).to.equal(0)
      })

      it("should not be callable a second time", async () => {
        await freshBridge.initializeV2_FixVaultZeroDeposit()

        await expect(
          freshBridge.initializeV2_FixVaultZeroDeposit()
        ).to.be.revertedWith("Initializable: contract is already initialized")
      })
    })
  })
})
