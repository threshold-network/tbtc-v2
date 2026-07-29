import fs from "fs"
import path from "path"

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { ethers } from "hardhat"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { smock } from "@defi-wonderland/smock"

import type { Bank, Bridge, TBTC, TBTCVault } from "../../typechain"
import { toSatoshis } from "../helpers/contract-test-helpers"
import { loadFixture } from "../helpers/fixture"

const SATOSHI_MULTIPLIER = ethers.BigNumber.from(10).pow(10)
const MAX_UINT256 = ethers.constants.MaxUint256
const ZERO = ethers.constants.Zero

const LCG_MASK_64 = (1n << 64n) - 1n
const LCG_MULTIPLIER = 6364136223846793005n
const LCG_INCREMENT = 1442695040888963407n

const INITIAL_ACCOUNT_BANK_BALANCE_SATS = toSatoshis(100)
const TOP_UP_MAX_SATS = 7500
const ACTION_MAX_SATS = 5000
const CAMPAIGN_ACCOUNT_COUNT = 4
// `BigNumber#toHexString()` pads to even-nibble length, which inserts
// a leading zero for odd-nibble values like `parseEther("100")`
// (`0x056b...`). Hardhat's `hardhat_setBalance` strictly enforces
// JSON-RPC QUANTITY (no leading zeros except for `0x0`) and rejects
// the padded form. Same normalization as round-11's bridgeFixture.ts fix.
const INITIAL_SIGNER_NATIVE_BALANCE = (() => {
  const padded = ethers.utils.parseEther("100").toHexString()
  const stripped = padded.replace(/^0x0+/, "0x")
  return stripped === "0x" ? "0x0" : stripped
})()
const MIN_FORMAL_SEEDS = 2
const MIN_FORMAL_STEPS_PER_SEED = 10

type SeedCorpus = {
  seeds: number[]
  steps_per_seed: number
}

const parsePositiveInteger = (rawValue: string, fieldName: string): number => {
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${fieldName} must be a positive integer`)
  }

  const parsedValue = Number(rawValue)
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${fieldName} must be a positive safe integer`)
  }

  return parsedValue
}

const loadSeedCorpus = (): SeedCorpus => {
  const configuredCorpusPath =
    process.env.TBTC_FORMAL_SEED_CORPUS_PATH ?? "seed-corpus.json"
  const resolvedCorpusPath = path.isAbsolute(configuredCorpusPath)
    ? configuredCorpusPath
    : path.resolve(__dirname, configuredCorpusPath)

  const parsedCorpus = JSON.parse(
    fs.readFileSync(resolvedCorpusPath, "utf8")
  ) as SeedCorpus

  if (!Array.isArray(parsedCorpus.seeds) || parsedCorpus.seeds.length === 0) {
    throw new Error(
      `TBTC formal seed corpus at [${resolvedCorpusPath}] must include at least one seed`
    )
  }

  if (
    !Number.isInteger(parsedCorpus.steps_per_seed) ||
    parsedCorpus.steps_per_seed <= 0
  ) {
    throw new Error(
      `TBTC formal seed corpus at [${resolvedCorpusPath}] must use a positive integer steps_per_seed`
    )
  }

  const defaultSeeds = parsedCorpus.seeds.map((seed, index) =>
    parsePositiveInteger(String(seed), `seed_corpus.seeds[${index}]`)
  )

  const seedsOverride = process.env.TBTC_FORMAL_SEEDS
  const stepsPerSeedOverride = process.env.TBTC_FORMAL_STEPS_PER_SEED

  const seeds =
    seedsOverride && seedsOverride.trim().length > 0
      ? seedsOverride
          .split(",")
          .map((seed, index) =>
            parsePositiveInteger(seed.trim(), `TBTC_FORMAL_SEEDS[${index}]`)
          )
      : defaultSeeds

  const stepsPerSeed =
    stepsPerSeedOverride && stepsPerSeedOverride.trim().length > 0
      ? parsePositiveInteger(
          stepsPerSeedOverride.trim(),
          "TBTC_FORMAL_STEPS_PER_SEED"
        )
      : parsedCorpus.steps_per_seed

  if (seeds.length < MIN_FORMAL_SEEDS) {
    throw new Error(
      `TBTC formal campaign requires at least ${MIN_FORMAL_SEEDS} seeds, got ${seeds.length}`
    )
  }

  if (stepsPerSeed < MIN_FORMAL_STEPS_PER_SEED) {
    throw new Error(
      `TBTC formal campaign requires at least ${MIN_FORMAL_STEPS_PER_SEED} steps_per_seed, got ${stepsPerSeed}`
    )
  }

  return {
    seeds,
    steps_per_seed: stepsPerSeed,
  }
}

const seedCorpus = loadSeedCorpus()

type BalanceModel = Map<string, BigNumber>

const addressKey = (address: string): string => address.toLowerCase()

const getModelBalance = (model: BalanceModel, address: string): BigNumber =>
  model.get(addressKey(address)) ?? ZERO

const setModelBalance = (
  model: BalanceModel,
  address: string,
  value: BigNumber
): void => {
  model.set(addressKey(address), value)
}

const addModelBalance = (
  model: BalanceModel,
  address: string,
  amount: BigNumber
): void => {
  setModelBalance(model, address, getModelBalance(model, address).add(amount))
}

const subModelBalance = (
  model: BalanceModel,
  address: string,
  amount: BigNumber
): void => {
  setModelBalance(model, address, getModelBalance(model, address).sub(amount))
}

const sumBigNumbers = (values: BigNumber[]): BigNumber =>
  values.reduce((accumulator, value) => accumulator.add(value), ZERO)

const makeRng = (seed: number): (() => number) => {
  let state = BigInt(seed) & LCG_MASK_64

  return () => {
    state = (state * LCG_MULTIPLIER + LCG_INCREMENT) & LCG_MASK_64
    return Number(state & 0xffffffffn)
  }
}

const randomIndex = (
  nextRandom: () => number,
  upperExclusive: number
): number => nextRandom() % upperExclusive

const randomSatoshis = (
  nextRandom: () => number,
  maxSatoshis: number
): BigNumber => ethers.BigNumber.from(nextRandom() % (maxSatoshis + 1))

const fixture = async () => {
  const [deployer, governance] = await ethers.getSigners()

  const bridge = await smock.fake<Bridge>("Bridge")
  const bridgeWalletAddress = await bridge.wallet.getAddress()
  await ethers.provider.send("hardhat_setBalance", [
    bridge.address,
    INITIAL_SIGNER_NATIVE_BALANCE,
  ])
  await ethers.provider.send("hardhat_setBalance", [
    bridgeWalletAddress,
    INITIAL_SIGNER_NATIVE_BALANCE,
  ])

  const bankFactory = await ethers.getContractFactory("Bank")
  const bank = await bankFactory.deploy()
  await bank.deployed()
  await bank.connect(deployer).updateBridge(bridge.address)

  const tbtcFactory = await ethers.getContractFactory("TBTC")
  const tbtc = await tbtcFactory.deploy()
  await tbtc.deployed()

  const vaultFactory = await ethers.getContractFactory("TBTCVault")
  const vault = await vaultFactory.deploy(
    bank.address,
    tbtc.address,
    bridge.address
  )
  await vault.deployed()

  await tbtc.connect(deployer).transferOwnership(vault.address)
  await vault.connect(deployer).transferOwnership(governance.address)

  const signers = await ethers.getSigners()
  // Start campaign accounts past the 10 named accounts (deployer, governance,
  // chaosnetOwner, esdm, etc.) defined in hardhat.config.ts namedAccounts.
  // Using signers[2..] previously collided with `governance` (signer 2), and
  // `hardhat_setBalance` here would reset governance's balance to 100 ETH —
  // breaking downstream tests like MaintainerProxy.submitDepositSweepProof
  // which depend on `governance` having enough ETH to fund test depositors
  // via `impersonateAccount(..., { from: governance, value: 10 ETH })`.
  const CAMPAIGN_ACCOUNTS_OFFSET = 10
  const campaignAccounts = signers.slice(
    CAMPAIGN_ACCOUNTS_OFFSET,
    CAMPAIGN_ACCOUNTS_OFFSET + CAMPAIGN_ACCOUNT_COUNT
  )
  if (campaignAccounts.length < CAMPAIGN_ACCOUNT_COUNT) {
    throw new Error(
      `Expected ${CAMPAIGN_ACCOUNT_COUNT} funded campaign signers, found ${campaignAccounts.length}`
    )
  }

  for (const account of campaignAccounts) {
    await ethers.provider.send("hardhat_setBalance", [
      account.address,
      INITIAL_SIGNER_NATIVE_BALANCE,
    ])
    await bank
      .connect(bridge.wallet)
      .increaseBalance(account.address, INITIAL_ACCOUNT_BANK_BALANCE_SATS)
    await bank.connect(account).approveBalance(vault.address, MAX_UINT256)
    await tbtc.connect(account).approve(vault.address, MAX_UINT256)
  }

  return {
    governance,
    bridge,
    bank,
    tbtc,
    vault,
    campaignAccounts,
  }
}

const assertCustodyInvariants = async (
  bank: Bank,
  tbtc: TBTC,
  vault: TBTCVault,
  campaignAccounts: SignerWithAddress[],
  expectedBankBalances: BalanceModel,
  expectedTbtcBalances: BalanceModel,
  totalBridgeIssuedSatoshis: BigNumber
): Promise<void> => {
  const trackedBankAddresses = [
    ...campaignAccounts.map((account) => account.address),
    vault.address,
  ]
  const onchainBankBalances = await Promise.all(
    trackedBankAddresses.map((address) => bank.balanceOf(address))
  )
  const onchainTrackedBankTotal = sumBigNumbers(onchainBankBalances)

  for (const [index, address] of trackedBankAddresses.entries()) {
    expect(onchainBankBalances[index]).to.equal(
      getModelBalance(expectedBankBalances, address)
    )
  }

  expect(onchainTrackedBankTotal).to.equal(totalBridgeIssuedSatoshis)

  const onchainTbtcBalances = await Promise.all(
    campaignAccounts.map((account) => tbtc.balanceOf(account.address))
  )
  for (const [index, account] of campaignAccounts.entries()) {
    expect(onchainTbtcBalances[index]).to.equal(
      getModelBalance(expectedTbtcBalances, account.address)
    )
  }

  const onchainTbtcTotalSupply = await tbtc.totalSupply()
  expect(sumBigNumbers(onchainTbtcBalances)).to.equal(onchainTbtcTotalSupply)

  const onchainVaultBankBalance = await bank.balanceOf(vault.address)
  expect(onchainTbtcTotalSupply).to.equal(
    onchainVaultBankBalance.mul(SATOSHI_MULTIPLIER)
  )
}

describe("CustodyInvariantHarness", () => {
  it("keeps governance gates fail-closed for bank and vault upgrade controls", async () => {
    const { governance, bank, vault, campaignAccounts } = await loadFixture(
      fixture
    )

    await expect(
      bank
        .connect(campaignAccounts[0])
        .updateBridge(campaignAccounts[0].address)
    ).to.be.revertedWith("Ownable: caller is not the owner")

    await expect(
      vault
        .connect(campaignAccounts[0])
        .initiateUpgrade(campaignAccounts[1].address)
    ).to.be.revertedWith("Ownable: caller is not the owner")

    await vault.connect(governance).initiateUpgrade(campaignAccounts[1].address)
    await expect(vault.connect(governance).finalizeUpgrade()).to.be.reverted
  })

  it("fails closed when transferBalanceFrom is called without allowance", async () => {
    const { bank, campaignAccounts } = await loadFixture(fixture)
    const owner = campaignAccounts[0]
    const spender = campaignAccounts[1]
    const recipient = campaignAccounts[2]
    const transferAmount = ethers.BigNumber.from(1)

    await expect(
      bank
        .connect(spender)
        .transferBalanceFrom(owner.address, recipient.address, transferAmount)
    ).to.be.revertedWith("Transfer amount exceeds allowance")
  })

  it("keeps custody accounting invariants for zero and max boundary amounts", async () => {
    const { bank, bridge, tbtc, vault, campaignAccounts } = await loadFixture(
      fixture
    )
    const expectedBankBalances: BalanceModel = new Map()
    const expectedTbtcBalances: BalanceModel = new Map()
    const sender = campaignAccounts[0]
    const recipient = campaignAccounts[1]
    let totalBridgeIssuedSatoshis = INITIAL_ACCOUNT_BANK_BALANCE_SATS.mul(
      campaignAccounts.length
    )

    for (const account of campaignAccounts) {
      setModelBalance(
        expectedBankBalances,
        account.address,
        INITIAL_ACCOUNT_BANK_BALANCE_SATS
      )
      setModelBalance(expectedTbtcBalances, account.address, ZERO)
    }
    setModelBalance(expectedBankBalances, vault.address, ZERO)

    await bank.connect(bridge.wallet).increaseBalance(sender.address, ZERO)
    await assertCustodyInvariants(
      bank,
      tbtc,
      vault,
      campaignAccounts,
      expectedBankBalances,
      expectedTbtcBalances,
      totalBridgeIssuedSatoshis
    )

    const topUpAmount = ethers.BigNumber.from(TOP_UP_MAX_SATS)
    await bank
      .connect(bridge.wallet)
      .increaseBalance(sender.address, topUpAmount)
    addModelBalance(expectedBankBalances, sender.address, topUpAmount)
    totalBridgeIssuedSatoshis = totalBridgeIssuedSatoshis.add(topUpAmount)

    await bank.connect(sender).transferBalance(recipient.address, ZERO)

    const transferAmount = ethers.BigNumber.from(ACTION_MAX_SATS)
    await bank
      .connect(sender)
      .transferBalance(recipient.address, transferAmount)
    subModelBalance(expectedBankBalances, sender.address, transferAmount)
    addModelBalance(expectedBankBalances, recipient.address, transferAmount)

    await vault.connect(sender).mint(ZERO)

    const mintSatoshis = ethers.BigNumber.from(ACTION_MAX_SATS)
    const mintAmount = mintSatoshis.mul(SATOSHI_MULTIPLIER)
    await vault.connect(sender).mint(mintAmount)
    subModelBalance(expectedBankBalances, sender.address, mintSatoshis)
    addModelBalance(expectedBankBalances, vault.address, mintSatoshis)
    addModelBalance(expectedTbtcBalances, sender.address, mintAmount)

    await vault.connect(sender).unmint(mintAmount)
    subModelBalance(expectedTbtcBalances, sender.address, mintAmount)
    subModelBalance(expectedBankBalances, vault.address, mintSatoshis)
    addModelBalance(expectedBankBalances, sender.address, mintSatoshis)

    await assertCustodyInvariants(
      bank,
      tbtc,
      vault,
      campaignAccounts,
      expectedBankBalances,
      expectedTbtcBalances,
      totalBridgeIssuedSatoshis
    )
  })

  for (const seed of seedCorpus.seeds) {
    it(`keeps custody accounting invariants under seeded campaign ${seed}`, async () => {
      const { bank, bridge, tbtc, vault, campaignAccounts } = await loadFixture(
        fixture
      )

      const nextRandom = makeRng(seed)
      const expectedBankBalances: BalanceModel = new Map()
      const expectedTbtcBalances: BalanceModel = new Map()

      let totalBridgeIssuedSatoshis = INITIAL_ACCOUNT_BANK_BALANCE_SATS.mul(
        campaignAccounts.length
      )

      for (const account of campaignAccounts) {
        setModelBalance(
          expectedBankBalances,
          account.address,
          INITIAL_ACCOUNT_BANK_BALANCE_SATS
        )
        setModelBalance(expectedTbtcBalances, account.address, ZERO)
      }
      setModelBalance(expectedBankBalances, vault.address, ZERO)

      await assertCustodyInvariants(
        bank,
        tbtc,
        vault,
        campaignAccounts,
        expectedBankBalances,
        expectedTbtcBalances,
        totalBridgeIssuedSatoshis
      )

      for (let step = 0; step < seedCorpus.steps_per_seed; step += 1) {
        const action = randomIndex(nextRandom, 7)

        if (action === 0) {
          const recipient =
            campaignAccounts[randomIndex(nextRandom, campaignAccounts.length)]
          const topUpAmount = randomSatoshis(nextRandom, TOP_UP_MAX_SATS)

          await bank
            .connect(bridge.wallet)
            .increaseBalance(recipient.address, topUpAmount)
          addModelBalance(expectedBankBalances, recipient.address, topUpAmount)
          totalBridgeIssuedSatoshis = totalBridgeIssuedSatoshis.add(topUpAmount)
        } else if (action === 1) {
          const senderIndex = randomIndex(nextRandom, campaignAccounts.length)
          let recipientIndex = randomIndex(nextRandom, campaignAccounts.length)
          while (recipientIndex === senderIndex) {
            recipientIndex = randomIndex(nextRandom, campaignAccounts.length)
          }

          const sender = campaignAccounts[senderIndex]
          const recipient = campaignAccounts[recipientIndex]
          const transferAmount = randomSatoshis(nextRandom, ACTION_MAX_SATS)
          const senderBalance = getModelBalance(
            expectedBankBalances,
            sender.address
          )

          if (senderBalance.gte(transferAmount)) {
            await bank
              .connect(sender)
              .transferBalance(recipient.address, transferAmount)
            subModelBalance(
              expectedBankBalances,
              sender.address,
              transferAmount
            )
            addModelBalance(
              expectedBankBalances,
              recipient.address,
              transferAmount
            )
          } else {
            await expect(
              bank
                .connect(sender)
                .transferBalance(recipient.address, transferAmount)
            ).to.be.revertedWith("Transfer amount exceeds balance")
          }
        } else if (action === 2) {
          const ownerIndex = randomIndex(nextRandom, campaignAccounts.length)
          let spenderIndex = randomIndex(nextRandom, campaignAccounts.length)
          while (spenderIndex === ownerIndex) {
            spenderIndex = randomIndex(nextRandom, campaignAccounts.length)
          }
          let recipientIndex = randomIndex(nextRandom, campaignAccounts.length)
          while (recipientIndex === ownerIndex) {
            recipientIndex = randomIndex(nextRandom, campaignAccounts.length)
          }

          const owner = campaignAccounts[ownerIndex]
          const spender = campaignAccounts[spenderIndex]
          const recipient = campaignAccounts[recipientIndex]
          const transferAmount = randomSatoshis(nextRandom, ACTION_MAX_SATS)
          const ownerBalance = getModelBalance(
            expectedBankBalances,
            owner.address
          )

          await bank
            .connect(owner)
            .increaseBalanceAllowance(spender.address, transferAmount)

          if (ownerBalance.gte(transferAmount)) {
            await bank
              .connect(spender)
              .transferBalanceFrom(
                owner.address,
                recipient.address,
                transferAmount
              )
            subModelBalance(expectedBankBalances, owner.address, transferAmount)
            addModelBalance(
              expectedBankBalances,
              recipient.address,
              transferAmount
            )
          } else {
            await expect(
              bank
                .connect(spender)
                .transferBalanceFrom(
                  owner.address,
                  recipient.address,
                  transferAmount
                )
            ).to.be.revertedWith("Transfer amount exceeds balance")
          }
        } else if (action === 3) {
          const account =
            campaignAccounts[randomIndex(nextRandom, campaignAccounts.length)]
          const satoshiAmount = randomSatoshis(nextRandom, ACTION_MAX_SATS)
          const mintAmount = satoshiAmount.mul(SATOSHI_MULTIPLIER)
          const accountBankBalance = getModelBalance(
            expectedBankBalances,
            account.address
          )

          if (accountBankBalance.gte(satoshiAmount)) {
            await vault.connect(account).mint(mintAmount)
            subModelBalance(
              expectedBankBalances,
              account.address,
              satoshiAmount
            )
            addModelBalance(expectedBankBalances, vault.address, satoshiAmount)
            addModelBalance(expectedTbtcBalances, account.address, mintAmount)
          } else {
            await expect(
              vault.connect(account).mint(mintAmount)
            ).to.be.revertedWith("Amount exceeds balance in the bank")
          }
        } else if (action === 4) {
          const account =
            campaignAccounts[randomIndex(nextRandom, campaignAccounts.length)]
          const satoshiAmount = randomSatoshis(nextRandom, ACTION_MAX_SATS)
          const unmintAmount = satoshiAmount.mul(SATOSHI_MULTIPLIER)
          const accountTbtcBalance = getModelBalance(
            expectedTbtcBalances,
            account.address
          )

          if (accountTbtcBalance.gte(unmintAmount)) {
            await vault.connect(account).unmint(unmintAmount)
            subModelBalance(expectedTbtcBalances, account.address, unmintAmount)
            subModelBalance(expectedBankBalances, vault.address, satoshiAmount)
            addModelBalance(
              expectedBankBalances,
              account.address,
              satoshiAmount
            )
          } else {
            await expect(vault.connect(account).unmint(unmintAmount)).to.be
              .reverted
          }
        } else if (action === 5) {
          const senderIndex = randomIndex(nextRandom, campaignAccounts.length)
          let recipientIndex = randomIndex(nextRandom, campaignAccounts.length)
          while (recipientIndex === senderIndex) {
            recipientIndex = randomIndex(nextRandom, campaignAccounts.length)
          }

          const sender = campaignAccounts[senderIndex]
          const recipient = campaignAccounts[recipientIndex]
          const transferAmount = randomSatoshis(
            nextRandom,
            ACTION_MAX_SATS
          ).mul(SATOSHI_MULTIPLIER)
          const senderTbtcBalance = getModelBalance(
            expectedTbtcBalances,
            sender.address
          )

          if (senderTbtcBalance.gte(transferAmount)) {
            await tbtc
              .connect(sender)
              .transfer(recipient.address, transferAmount)
            subModelBalance(
              expectedTbtcBalances,
              sender.address,
              transferAmount
            )
            addModelBalance(
              expectedTbtcBalances,
              recipient.address,
              transferAmount
            )
          } else {
            await expect(
              tbtc.connect(sender).transfer(recipient.address, transferAmount)
            ).to.be.revertedWith("Transfer amount exceeds balance")
          }
        } else {
          const nonGovernance =
            campaignAccounts[randomIndex(nextRandom, campaignAccounts.length)]
          if (nextRandom() % 2 === 0) {
            await expect(
              bank.connect(nonGovernance).updateBridge(vault.address)
            ).to.be.revertedWith("Ownable: caller is not the owner")
          } else {
            await expect(
              vault
                .connect(nonGovernance)
                .initiateUpgrade(campaignAccounts[0].address)
            ).to.be.revertedWith("Ownable: caller is not the owner")
          }
        }

        await assertCustodyInvariants(
          bank,
          tbtc,
          vault,
          campaignAccounts,
          expectedBankBalances,
          expectedTbtcBalances,
          totalBridgeIssuedSatoshis
        )
      }
    })
  }
})
