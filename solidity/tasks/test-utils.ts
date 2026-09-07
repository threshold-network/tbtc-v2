import { toNumber, toBigInt, BigNumberish, BytesLike } from "ethers"
import { task, types } from "hardhat/config"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import type {
  TestERC20,
  Bridge,
  SortitionPool,
  WalletRegistry,
} from "../typechain"
import type { WalletRegistryGovernance } from "../typechain/external/WalletRegistryGovernance"
import type { RandomBeaconGovernance } from "../typechain/external/RandomBeaconGovernance"
import type { RandomBeacon } from "../typechain/external/RandomBeacon"
import type { TokenStaking } from "../typechain/external/TokenStaking"
/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */

import { authorizeApplication, stake } from "../test/integration/utils/staking"
import {
  performEcdsaDkg,
  registerOperator,
} from "../test/integration/utils/ecdsa-wallet-registry"
import {
  offchainDkgTime,
  dkgResultChallengePeriodLength,
} from "../test/integration/data/integration"
import blsData from "../test/integration/data/bls"
import {
  updateDkgResultChallengePeriodLength,
  getGenesisSeed,
  selectGroup,
  signDkgResult,
  hashDKGMembers,
} from "../test/integration/utils/random-beacon"

export type OperatorID = number
export type Operator = { id: OperatorID; signer: HardhatEthersSigner }

task(
  "test-utils:register-operators",
  "Registers operators in the sortition pools"
)
  .addOptionalParam(
    "numberOfOperators",
    "Number of operators to register",
    110,
    types.int
  )
  .addOptionalParam(
    "unnamedSignersOffset",
    "Offset indicating the unnamed signers",
    0,
    types.int
  )
  .addOptionalParam(
    "stakeAmount",
    "Amount of each operator's stake",
    "40000000000000000000000",
    types.string
  )
  .setAction(async (args, hre) => {
    const { numberOfOperators, unnamedSignersOffset, stakeAmount } = args
    await registerOperators(
      hre,
      numberOfOperators,
      unnamedSignersOffset,
      stakeAmount
    )
  })

task(
  "test-utils:create-wallet",
  "Creates a wallet and registers it in the bridge"
)
  .addParam(
    "walletPublicKey",
    "Uncompressed wallet ECDSA public key",
    undefined,
    types.string
  )
  .setAction(async (args, hre) => {
    const { walletPublicKey } = args
    await createWallet(hre, walletPublicKey)
  })

async function registerOperators(
  hre: HardhatRuntimeEnvironment,
  numberOfOperators: number,
  unnamedSignersOffset: number,
  stakeAmount: BigNumberish
): Promise<void> {
  const { helpers } = hre

  const { chaosnetOwner } = await helpers.signers.getNamedSigners()

  const walletRegistry = await helpers.contracts.getContract<WalletRegistry>(
    "WalletRegistry"
  )
  const ecdsaSortitionPool = await helpers.contracts.getContract<SortitionPool>(
    "EcdsaSortitionPool"
  )
  const t = await helpers.contracts.getContract<TestERC20>("T")
  const staking = await helpers.contracts.getContract<TokenStaking>(
    "TokenStaking"
  )

  if (await ecdsaSortitionPool.isChaosnetActive()) {
    await ecdsaSortitionPool.connect(chaosnetOwner).deactivateChaosnet()
  }

  const randomBeacon = await helpers.contracts.getContract<RandomBeacon>(
    "RandomBeacon"
  )
  const beaconSortitionPool =
    await helpers.contracts.getContract<SortitionPool>("BeaconSortitionPool")

  if (await beaconSortitionPool.isChaosnetActive()) {
    await beaconSortitionPool.connect(chaosnetOwner).deactivateChaosnet()
  }

  const signers = (await helpers.signers.getUnnamedSigners()).slice(
    unnamedSignersOffset
  )

  // We use unique accounts for each staking role for each operator.
  if (signers.length < numberOfOperators * 5) {
    throw new Error(
      "not enough unnamed signers; update hardhat network's configuration account count"
    )
  }

  console.log(`Starting registration of ${numberOfOperators} operators`)

  for (let i = 0; i < numberOfOperators; i++) {
    const owner = signers[i]
    const stakingProvider = signers[1 * numberOfOperators + i]
    const operator = signers[2 * numberOfOperators + i]
    const beneficiary = signers[3 * numberOfOperators + i]
    const authorizer = signers[4 * numberOfOperators + i]

    console.log(`Registering operator ${i} with address ${operator.address}`)

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
      walletRegistry.target,
      authorizer,
      stakingProvider.address,
      stakeAmount
    )
    await authorizeApplication(
      staking,
      randomBeacon.target,
      authorizer,
      stakingProvider.address,
      stakeAmount
    )
    await registerOperator(
      walletRegistry,
      ecdsaSortitionPool,
      stakingProvider,
      operator
    )
    await randomBeacon
      .connect(stakingProvider)
      .registerOperator(await operator.getAddress())

    await randomBeacon.connect(operator).joinSortitionPool()
  }

  console.log(`Registered ${numberOfOperators} sortition pool operators`)
}

async function createWallet(
  hre: HardhatRuntimeEnvironment,
  walletPublicKey: BytesLike
): Promise<void> {
  const { ethers, helpers } = hre
  const { governance } = await helpers.signers.getNamedSigners()

  const bridge = await helpers.contracts.getContract<Bridge>("Bridge")
  const walletRegistry = await helpers.contracts.getContract<WalletRegistry>(
    "WalletRegistry"
  )
  const walletRegistryGovernance =
    await helpers.contracts.getContract<WalletRegistryGovernance>(
      "WalletRegistryGovernance"
    )
  const randomBeacon = await helpers.contracts.getContract<RandomBeacon>(
    "RandomBeacon"
  )
  const randomBeaconGovernance =
    await helpers.contracts.getContract<RandomBeaconGovernance>(
      "RandomBeaconGovernance"
    )

  await updateDkgResultChallengePeriodLength(
    hre,
    governance,
    randomBeaconGovernance
  )

  const genesisTx = await randomBeacon.genesis()
  const genesisBlock = genesisTx.blockNumber
  const genesisSeed = await getGenesisSeed(hre, genesisBlock)

  await helpers.time.mineBlocksTo(genesisBlock + offchainDkgTime + 1)

  const sortitionPool = await helpers.contracts.getContract<SortitionPool>(
    "BeaconSortitionPool"
  )

  const signers = await selectGroup(hre, sortitionPool, genesisSeed)
  const { members, signingMembersIndices, signaturesBytes } =
    await signDkgResult(hre, signers, blsData.groupPubKey, [], genesisBlock, 33)
  const membersHash = hashDKGMembers(hre, members, [])

  const dkgResult = {
    submitterMemberIndex: 1,
    groupPubKey: blsData.groupPubKey,
    misbehavedMembersIndices: [],
    signatures: signaturesBytes,
    signingMembersIndices,
    members,
    membersHash,
  }

  const submitter = signers[0].signer
  await randomBeacon.connect(submitter).submitDkgResult(dkgResult)

  await helpers.time.mineBlocks(dkgResultChallengePeriodLength + 1)

  await randomBeacon.connect(submitter).approveDkgResult(dkgResult)

  const requestNewWalletTx = await bridge.requestNewWallet({
    txHash: ethers.ZeroHash,
    txOutputIndex: 0,
    txOutputValue: 0,
  })

  // Using smock to make a fake RandomBeacon instance does not work in the
  // task environment. In order to provide a relay entry to the registry, we
  // set the governance as the random beacon and provide a relay entry as usual.
  await walletRegistryGovernance
    .connect(governance)
    .upgradeRandomBeacon(governance.address)
  // eslint-disable-next-line no-underscore-dangle
  await walletRegistry
    .connect(governance)
    .__beaconCallback(ethers.toBigInt(ethers.randomBytes(32)), 0)

  await performEcdsaDkg(
    hre,
    walletRegistry,
    walletPublicKey,
    requestNewWalletTx.blockNumber
  )

  console.log(`Created wallet with public key ${walletPublicKey}`)
}

export default {
  registerOperators,
  createWallet,
}
