import { randomBytes } from "crypto"
import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { to1e18 } from "../helpers/contract-test-helpers"
import type {
  FeeRouter,
  StakingGasStipendForwarder,
  StakingMockBank,
  StakingFeeMockRewardsDistributor,
  StakingMockTBTCVault,
  StakingRevertingEthReceiver,
  StakingTestToken,
} from "../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { increaseTime } = helpers.time

const ZERO_ADDRESS = ethers.constants.AddressZero
const SATOSHI_MULTIPLIER = BigNumber.from(10).pow(10)
const GOVERNANCE_DELAY = 3600
const DEFAULT_REWARD_SHARE_BPS = 5000

describe("FeeRouter", () => {
  let deployer: SignerWithAddress
  let daoTreasury: SignerWithAddress
  let thirdParty: SignerWithAddress

  let tbtc: StakingTestToken
  let bank: StakingMockBank
  let tbtcVault: StakingMockTBTCVault
  let rewardsDistributor: StakingFeeMockRewardsDistributor
  let feeRouter: FeeRouter

  async function deployRouter(
    overrides: Partial<{
      bank: string
      tbtcVault: string
      tbtcToken: string
      rewardsDistributor: string
      daoTreasury: string
      rewardShareBps: number
      governanceDelay: number
    }> = {}
  ): Promise<FeeRouter> {
    const deployment = await helpers.upgrades.deployProxy(
      // Hacky workaround allowing to deploy proxy contract any number of times
      // without clearing `deployments/hardhat` directory.
      // See: https://github.com/keep-network/hardhat-helpers/issues/38
      `FeeRouter_${randomBytes(8).toString("hex")}`,
      {
        contractName: "FeeRouter",
        initializerArgs: [
          overrides.bank ?? bank.address,
          overrides.tbtcVault ?? tbtcVault.address,
          overrides.tbtcToken ?? tbtc.address,
          overrides.rewardsDistributor ?? rewardsDistributor.address,
          overrides.daoTreasury ?? daoTreasury.address,
          overrides.rewardShareBps ?? DEFAULT_REWARD_SHARE_BPS,
          overrides.governanceDelay ?? GOVERNANCE_DELAY,
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: {
          kind: "transparent",
        },
      }
    )
    return deployment[0] as FeeRouter
  }

  async function expectDeploymentRevert(
    overrides: Parameters<typeof deployRouter>[0]
  ): Promise<void> {
    let failed = false
    try {
      await deployRouter(overrides)
    } catch (err) {
      failed = true
    }
    expect(failed, "expected proxy deployment to revert").to.be.true
  }

  const fixture = async () => {
    const signers = await ethers.getSigners()
    ;[deployer, daoTreasury, thirdParty] = signers

    // Fully qualified names: other staking test suites define mocks with
    // overlapping contract names.
    const TokenFactory = await ethers.getContractFactory(
      "contracts/test/staking/StakingFeeMocks.sol:StakingTestToken"
    )
    tbtc = (await TokenFactory.connect(deployer).deploy()) as StakingTestToken

    const BankFactory = await ethers.getContractFactory(
      "contracts/test/staking/StakingFeeMocks.sol:StakingMockBank"
    )
    bank = (await BankFactory.connect(deployer).deploy()) as StakingMockBank

    const VaultFactory = await ethers.getContractFactory(
      "contracts/test/staking/StakingFeeMocks.sol:StakingMockTBTCVault"
    )
    tbtcVault = (await VaultFactory.connect(deployer).deploy(
      bank.address,
      tbtc.address
    )) as StakingMockTBTCVault

    const DistributorFactory = await ethers.getContractFactory(
      "contracts/test/staking/StakingFeeMocks.sol:StakingFeeMockRewardsDistributor"
    )
    rewardsDistributor = (await DistributorFactory.connect(
      deployer
    ).deploy()) as StakingFeeMockRewardsDistributor

    feeRouter = await deployRouter()

    return {
      tbtc,
      bank,
      tbtcVault,
      rewardsDistributor,
      feeRouter,
    }
  }

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ tbtc, bank, tbtcVault, rewardsDistributor, feeRouter } =
      await waffle.loadFixture(fixture))
  })

  describe("initialize", () => {
    it("should wire all addresses and parameters", async () => {
      expect(await feeRouter.bank()).to.equal(bank.address)
      expect(await feeRouter.tbtcVault()).to.equal(tbtcVault.address)
      expect(await feeRouter.tbtcToken()).to.equal(tbtc.address)
      expect(await feeRouter.rewardsDistributor()).to.equal(
        rewardsDistributor.address
      )
      expect(await feeRouter.daoTreasury()).to.equal(daoTreasury.address)
      expect(await feeRouter.rewardShareBps()).to.equal(
        DEFAULT_REWARD_SHARE_BPS
      )
      expect(await feeRouter.governanceDelay()).to.equal(GOVERNANCE_DELAY)
      expect(await feeRouter.SATOSHI_MULTIPLIER()).to.equal(SATOSHI_MULTIPLIER)
    })

    it("should revert when initialized again", async () => {
      await expect(
        feeRouter.initialize(
          bank.address,
          tbtcVault.address,
          tbtc.address,
          rewardsDistributor.address,
          daoTreasury.address,
          DEFAULT_REWARD_SHARE_BPS,
          GOVERNANCE_DELAY
        )
      ).to.be.revertedWith("Initializable: contract is already initialized")
    })

    it("should revert given a zero bank address", async () => {
      await expectDeploymentRevert({ bank: ZERO_ADDRESS })
    })

    it("should revert given a zero vault address", async () => {
      await expectDeploymentRevert({ tbtcVault: ZERO_ADDRESS })
    })

    it("should revert given a zero token address", async () => {
      await expectDeploymentRevert({ tbtcToken: ZERO_ADDRESS })
    })

    it("should revert given a zero distributor address", async () => {
      await expectDeploymentRevert({ rewardsDistributor: ZERO_ADDRESS })
    })

    it("should revert given a zero treasury address", async () => {
      await expectDeploymentRevert({ daoTreasury: ZERO_ADDRESS })
    })

    it("should revert given a reward share above 100%", async () => {
      await expectDeploymentRevert({ rewardShareBps: 10001 })
    })
  })

  describe("receive", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should accept a plain ETH transfer", async () => {
      await thirdParty.sendTransaction({
        to: feeRouter.address,
        value: to1e18(1),
      })
      expect(await ethers.provider.getBalance(feeRouter.address)).to.equal(
        to1e18(1)
      )
    })

    it("should succeed within the 100k gas stipend used by Fraud.sol", async () => {
      const ForwarderFactory = await ethers.getContractFactory(
        "contracts/test/staking/StakingFeeMocks.sol:StakingGasStipendForwarder"
      )
      const forwarder = (await ForwarderFactory.connect(
        deployer
      ).deploy()) as StakingGasStipendForwarder

      const balanceBefore = await ethers.provider.getBalance(feeRouter.address)

      // The forwarder sends with exactly 100,000 gas and reverts if the
      // transfer fails.
      await forwarder
        .connect(thirdParty)
        .forward(feeRouter.address, { value: to1e18(2) })

      expect(await ethers.provider.getBalance(feeRouter.address)).to.equal(
        balanceBefore.add(to1e18(2))
      )
      expect(await forwarder.lastGasUsed()).to.be.lt(100000)
    })
  })

  describe("distribute", () => {
    context("when the router holds Bank satoshis", () => {
      const satoshis = 1000000 // 0.01 BTC
      const mintedTbtc = BigNumber.from(satoshis).mul(SATOSHI_MULTIPLIER)

      before(async () => {
        await createSnapshot()
        await bank.setBalance(feeRouter.address, satoshis)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should convert the full satoshi balance and split the TBTC", async () => {
        const tx = await feeRouter.connect(thirdParty).distribute()

        const rewardShare = mintedTbtc.mul(DEFAULT_REWARD_SHARE_BPS).div(10000)
        const treasuryShare = mintedTbtc.sub(rewardShare)

        // Bank leg: the satoshis moved from the router to the vault and the
        // allowance was fully consumed.
        expect(await bank.balanceOf(feeRouter.address)).to.equal(0)
        expect(await bank.balanceOf(tbtcVault.address)).to.equal(satoshis)
        expect(
          await bank.allowance(feeRouter.address, tbtcVault.address)
        ).to.equal(0)

        // TBTC leg: 1 sat -> 1e10 TBTC wei, split by rewardShareBps.
        expect(await tbtc.balanceOf(feeRouter.address)).to.equal(0)
        expect(await tbtc.balanceOf(rewardsDistributor.address)).to.equal(
          rewardShare
        )
        expect(await tbtc.balanceOf(daoTreasury.address)).to.equal(
          treasuryShare
        )

        // The distributor was notified after the transfer.
        expect(await rewardsDistributor.notifyCount()).to.equal(1)
        expect(await rewardsDistributor.lastNotifiedAmount()).to.equal(
          rewardShare
        )

        await expect(tx)
          .to.emit(feeRouter, "RevenueDistributed")
          .withArgs(satoshis, rewardShare, treasuryShare, 0)
      })

      it("should distribute again after a new accrual (allowance is not blocked)", async () => {
        // The Bank forbids overwriting a non-zero allowance with a non-zero
        // value. A second distribution proves the allowance is consumed
        // exactly each round.
        await bank.setBalance(feeRouter.address, satoshis)
        await feeRouter.connect(thirdParty).distribute()

        expect(await bank.balanceOf(feeRouter.address)).to.equal(0)
        expect(await bank.balanceOf(tbtcVault.address)).to.equal(2 * satoshis)
        expect(await rewardsDistributor.notifyCount()).to.equal(2)
      })
    })

    context("when TBTC arrives at the router directly", () => {
      before(async () => {
        await createSnapshot()
        await tbtc.mint(feeRouter.address, to1e18(2))
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should split the TBTC without touching the Bank", async () => {
        const tx = await feeRouter.connect(thirdParty).distribute()

        expect(await tbtc.balanceOf(feeRouter.address)).to.equal(0)
        expect(await tbtc.balanceOf(rewardsDistributor.address)).to.equal(
          to1e18(1)
        )
        expect(await tbtc.balanceOf(daoTreasury.address)).to.equal(to1e18(1))
        expect(await rewardsDistributor.lastNotifiedAmount()).to.equal(
          to1e18(1)
        )
        expect(await bank.balanceOf(tbtcVault.address)).to.equal(0)

        await expect(tx)
          .to.emit(feeRouter, "RevenueDistributed")
          .withArgs(0, to1e18(1), to1e18(1), 0)
      })

      it("should round the reward share down on odd amounts", async () => {
        // 3 wei at 50%: reward share 1 wei, treasury 2 wei.
        await tbtc.mint(feeRouter.address, 3)
        await feeRouter.connect(thirdParty).distribute()

        expect(await tbtc.balanceOf(rewardsDistributor.address)).to.equal(
          to1e18(1).add(1)
        )
        expect(await tbtc.balanceOf(daoTreasury.address)).to.equal(
          to1e18(1).add(2)
        )
      })
    })

    context("when the router holds ETH", () => {
      before(async () => {
        await createSnapshot()
        await thirdParty.sendTransaction({
          to: feeRouter.address,
          value: to1e18(3),
        })
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should pass the full ETH balance to the DAO treasury", async () => {
        const treasuryBalanceBefore = await ethers.provider.getBalance(
          daoTreasury.address
        )

        const tx = await feeRouter.connect(thirdParty).distribute()

        expect(await ethers.provider.getBalance(feeRouter.address)).to.equal(0)
        expect(await ethers.provider.getBalance(daoTreasury.address)).to.equal(
          treasuryBalanceBefore.add(to1e18(3))
        )

        await expect(tx)
          .to.emit(feeRouter, "RevenueDistributed")
          .withArgs(0, 0, 0, to1e18(3))
      })

      it("should revert when the treasury rejects ETH", async () => {
        const RejecterFactory = await ethers.getContractFactory(
          "contracts/test/staking/StakingFeeMocks.sol:StakingRevertingEthReceiver"
        )
        const rejecter = (await RejecterFactory.connect(
          deployer
        ).deploy()) as StakingRevertingEthReceiver

        const rejectingRouter = await deployRouter({
          daoTreasury: rejecter.address,
        })
        await thirdParty.sendTransaction({
          to: rejectingRouter.address,
          value: to1e18(1),
        })

        await expect(
          rejectingRouter.connect(thirdParty).distribute()
        ).to.be.revertedWith("EthTransferFailed")
      })
    })

    context("when all revenue legs are non-zero", () => {
      const satoshis = 50000
      const mintedTbtc = BigNumber.from(satoshis).mul(SATOSHI_MULTIPLIER)
      const directTbtc = to1e18(4)
      const eth = to1e18(2)

      before(async () => {
        await createSnapshot()
        await bank.setBalance(feeRouter.address, satoshis)
        await tbtc.mint(feeRouter.address, directTbtc)
        await thirdParty.sendTransaction({
          to: feeRouter.address,
          value: eth,
        })
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should handle Bank sats, direct TBTC, and ETH in one call", async () => {
        const totalTbtc = mintedTbtc.add(directTbtc)
        const rewardShare = totalTbtc.mul(DEFAULT_REWARD_SHARE_BPS).div(10000)
        const treasuryShare = totalTbtc.sub(rewardShare)
        const treasuryEthBefore = await ethers.provider.getBalance(
          daoTreasury.address
        )

        const tx = await feeRouter.connect(thirdParty).distribute()

        expect(await bank.balanceOf(feeRouter.address)).to.equal(0)
        expect(await tbtc.balanceOf(feeRouter.address)).to.equal(0)
        expect(await ethers.provider.getBalance(feeRouter.address)).to.equal(0)

        expect(await tbtc.balanceOf(rewardsDistributor.address)).to.equal(
          rewardShare
        )
        expect(await tbtc.balanceOf(daoTreasury.address)).to.equal(
          treasuryShare
        )
        expect(await ethers.provider.getBalance(daoTreasury.address)).to.equal(
          treasuryEthBefore.add(eth)
        )
        expect(await rewardsDistributor.lastNotifiedAmount()).to.equal(
          rewardShare
        )

        await expect(tx)
          .to.emit(feeRouter, "RevenueDistributed")
          .withArgs(satoshis, rewardShare, treasuryShare, eth)
      })
    })

    context("when there is no revenue at all", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should be a no-op, not a revert", async () => {
        const tx = await feeRouter.connect(thirdParty).distribute()

        await expect(tx).to.not.emit(feeRouter, "RevenueDistributed")
        expect(await rewardsDistributor.notifyCount()).to.equal(0)
        expect(await tbtc.balanceOf(daoTreasury.address)).to.equal(0)
      })
    })

    context("when the reward share is 0%", () => {
      before(async () => {
        await createSnapshot()
        await feeRouter.connect(deployer).beginRewardShareBpsUpdate(0)
        await increaseTime(GOVERNANCE_DELAY)
        await feeRouter.connect(deployer).finalizeRewardShareBpsUpdate()
        await tbtc.mint(feeRouter.address, to1e18(5))
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should send everything to the DAO and skip the distributor", async () => {
        await feeRouter.connect(thirdParty).distribute()

        expect(await tbtc.balanceOf(daoTreasury.address)).to.equal(to1e18(5))
        expect(await tbtc.balanceOf(rewardsDistributor.address)).to.equal(0)
        expect(await rewardsDistributor.notifyCount()).to.equal(0)
      })
    })

    context("when the reward share is 100%", () => {
      before(async () => {
        await createSnapshot()
        await feeRouter.connect(deployer).beginRewardShareBpsUpdate(10000)
        await increaseTime(GOVERNANCE_DELAY)
        await feeRouter.connect(deployer).finalizeRewardShareBpsUpdate()
        await tbtc.mint(feeRouter.address, to1e18(5))
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should send everything to the distributor and nothing to the DAO", async () => {
        await feeRouter.connect(thirdParty).distribute()

        expect(await tbtc.balanceOf(daoTreasury.address)).to.equal(0)
        expect(await tbtc.balanceOf(rewardsDistributor.address)).to.equal(
          to1e18(5)
        )
        expect(await rewardsDistributor.lastNotifiedAmount()).to.equal(
          to1e18(5)
        )
      })
    })
  })

  describe("rewardShareBps update", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the caller is not the owner", () => {
      it("should revert on begin", async () => {
        await expect(
          feeRouter.connect(thirdParty).beginRewardShareBpsUpdate(1000)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })

      it("should revert on finalize", async () => {
        await expect(
          feeRouter.connect(thirdParty).finalizeRewardShareBpsUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      it("should revert given a value above 100%", async () => {
        await expect(
          feeRouter.connect(deployer).beginRewardShareBpsUpdate(10001)
        ).to.be.revertedWith("RewardShareBpsExceedsMax")
      })

      it("should revert on finalize when no update was initiated", async () => {
        await expect(
          feeRouter.connect(deployer).finalizeRewardShareBpsUpdate()
        ).to.be.revertedWith("Change not initiated")
      })

      context("with a pending update", () => {
        before(async () => {
          await createSnapshot()
          await feeRouter.connect(deployer).beginRewardShareBpsUpdate(2500)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should record the pending value and not apply it yet", async () => {
          expect(await feeRouter.newRewardShareBps()).to.equal(2500)
          expect(await feeRouter.rewardShareBps()).to.equal(
            DEFAULT_REWARD_SHARE_BPS
          )
          expect(await feeRouter.rewardShareBpsChangeInitiated()).to.be.gt(0)
        })

        it("should revert on finalize before the governance delay", async () => {
          await expect(
            feeRouter.connect(deployer).finalizeRewardShareBpsUpdate()
          ).to.be.revertedWith("Governance delay has not elapsed")
        })

        it("should apply the value after the governance delay and reset", async () => {
          await increaseTime(GOVERNANCE_DELAY)

          const tx = await feeRouter
            .connect(deployer)
            .finalizeRewardShareBpsUpdate()

          await expect(tx)
            .to.emit(feeRouter, "RewardShareBpsUpdated")
            .withArgs(2500)
          expect(await feeRouter.rewardShareBps()).to.equal(2500)
          expect(await feeRouter.newRewardShareBps()).to.equal(0)
          expect(await feeRouter.rewardShareBpsChangeInitiated()).to.equal(0)
        })
      })
    })
  })
})
