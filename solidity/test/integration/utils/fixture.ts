/* eslint-disable no-await-in-loop */

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { Contract } from "ethers"
import hre, { deployments, ethers, helpers } from "hardhat"
import {
  TBTC,
  Bridge,
  TBTCVault,
  IRelay,
  IRandomBeacon,
  WalletRegistry,
  BridgeGovernance,
} from "../../../typechain"
import { Bank } from "../../../typechain/Bank"
import { registerOperator } from "./ecdsa-wallet-registry"
import { fakeRandomBeacon } from "./fake-random-beacon"
import { authorizeApplication, stake } from "./staking"
import { createMock } from "../../helpers/mock"
import type { Mock } from "../../helpers/mock"

const { to1e18 } = helpers.number

// Number of operators to register in the sortition pool
const numberOfOperators = 110

const unnamedSignersOffset = 0
const stakeAmount = to1e18(40_000)

// eslint-disable-next-line import/prefer-default-export
export const fixture = deployments.createFixture(
  async (): Promise<{
    deployer: SignerWithAddress
    governance: SignerWithAddress
    spvMaintainer: SignerWithAddress
    tbtc: TBTC
    bridge: Bridge
    bridgeGovernance: BridgeGovernance
    bank: Bank
    tbtcVault: TBTCVault
    walletRegistry: WalletRegistry
    staking: Contract
    randomBeacon: Mock<IRandomBeacon>
    relay: Mock<IRelay>
  }> => {
    await deployments.fixture()
    const { deployer, governance, chaosnetOwner, spvMaintainer } =
      await helpers.signers.getNamedSigners()

    const tbtc = await helpers.contracts.getContract<TBTC>("TBTC")
    const bridge = await helpers.contracts.getContract<Bridge>("Bridge")
    const bridgeGovernance =
      await helpers.contracts.getContract<BridgeGovernance>("BridgeGovernance")
    const bank = await helpers.contracts.getContract<Bank>("Bank")
    const tbtcVault: TBTCVault = await helpers.contracts.getContract(
      "TBTCVault"
    )
    const walletRegistry = await helpers.contracts.getContract<WalletRegistry>(
      "WalletRegistry"
    )
    const t = await helpers.contracts.getContract("T")
    const staking = await helpers.contracts.getContract("TokenStaking")

    await tbtc.connect(deployer).transferOwnership(tbtcVault.address)

    // TODO: INTEGRATE WITH THE REAL BEACON
    const randomBeacon = await fakeRandomBeacon(walletRegistry)

    const sortitionPool = await ethers.getContractAt(
      "SortitionPool",
      await walletRegistry.sortitionPool()
    )
    await sortitionPool.connect(chaosnetOwner).deactivateChaosnet()

    // TODO: INTEGRATE WITH THE REAL LIGHT RELAY
    const relay = await createMock<IRelay>("IRelay", {
      address: await (await bridge.contractReferences()).relay,
    })

    const signers = (await helpers.signers.getUnnamedSigners()).slice(
      unnamedSignersOffset
    )

    // We use unique accounts for each staking role for each operator.
    if (signers.length < numberOfOperators * 5) {
      throw new Error(
        "not enough unnamed signers; update hardhat network's configuration account count"
      )
    }

    for (let i = 0; i < numberOfOperators; i++) {
      const owner: SignerWithAddress = signers[i]
      const stakingProvider: SignerWithAddress =
        signers[1 * numberOfOperators + i]
      const operator: SignerWithAddress = signers[2 * numberOfOperators + i]
      const beneficiary: SignerWithAddress = signers[3 * numberOfOperators + i]
      const authorizer: SignerWithAddress = signers[4 * numberOfOperators + i]

      await stake(
        hre,
        t,
        staking,
        stakeAmount,
        owner,
        stakingProvider.address,
        beneficiary.address,
        authorizer.address
      )
      await authorizeApplication(
        staking,
        walletRegistry.address,
        authorizer,
        stakingProvider.address,
        stakeAmount
      )
      await registerOperator(
        walletRegistry,
        sortitionPool,
        stakingProvider,
        operator
      )
    }

    return {
      deployer,
      governance,
      spvMaintainer,
      tbtc,
      bridge,
      bridgeGovernance,
      bank,
      tbtcVault,
      walletRegistry,
      staking,
      randomBeacon,
      relay,
    }
  }
)
