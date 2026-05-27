/* eslint-disable no-await-in-loop */

import { FakeContract, smock } from "@defi-wonderland/smock"
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
  EcdsaFraudRouter,
  P2TRSignatureFraudRouter,
} from "../../../typechain"
import { Bank } from "../../../typechain/Bank"
import { registerOperator } from "./ecdsa-wallet-registry"
import { fakeRandomBeacon } from "./fake-random-beacon"
import { authorizeApplication, stake } from "./staking"

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
    randomBeacon: FakeContract<IRandomBeacon>
    relay: FakeContract<IRelay>
    ecdsaFraudRouter: EcdsaFraudRouter
    p2trFraudRouter: P2TRSignatureFraudRouter
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
    const relay = await smock.fake<IRelay>("IRelay", {
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

    // Deploy + wire the two fraud router sidecars (same pattern as
    // the unit-test bridgeFixture). The deploy scripts at
    // deploy/44_deploy_ecdsa_fraud_router.ts and
    // deploy/45_deploy_p2tr_signature_fraud_router.ts run during
    // deployments.fixture() above; this block calls the one-time
    // governance setters so the routers are usable for integration
    // tests that exercise fraud paths through MaintainerProxy.
    const existingEcdsaFraudRouter = await bridge.ecdsaFraudRouter()
    let ecdsaFraudRouter: EcdsaFraudRouter
    if (existingEcdsaFraudRouter === ethers.constants.AddressZero) {
      ecdsaFraudRouter = await helpers.contracts.getContract<EcdsaFraudRouter>(
        "EcdsaFraudRouter"
      )
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
      p2trFraudRouter =
        await helpers.contracts.getContract<P2TRSignatureFraudRouter>(
          "P2TRSignatureFraudRouter"
        )
      await bridgeGovernance
        .connect(governance)
        .setP2TRFraudRouter(p2trFraudRouter.address)
    } else {
      p2trFraudRouter = (await ethers.getContractAt(
        "P2TRSignatureFraudRouter",
        existingP2TRFraudRouter
      )) as P2TRSignatureFraudRouter
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
      ecdsaFraudRouter,
      p2trFraudRouter,
    }
  }
)
