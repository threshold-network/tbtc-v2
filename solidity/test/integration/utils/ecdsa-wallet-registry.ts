// TODO: Utils in this file are pulled from @keep-network/ecdsa test utils.
// We should consider exposing them in @keep-network/ecdsa for an external usage.

/* eslint-disable no-await-in-loop */

import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import type {
  ContractTransactionResponse,
  BytesLike,
  BigNumberish,
  Signer,
} from "ethers"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import type { WalletRegistry, SortitionPool } from "../../../typechain"
import type { ClaimStruct } from "../../../typechain/EcdsaInactivity"

// default Hardhat's networks blockchain, see https://hardhat.org/config/
export const hardhatNetworkId = 31337

export async function registerOperator(
  walletRegistry: WalletRegistry,
  sortitionPool: SortitionPool,
  stakingProvider: Signer,
  operator: Signer
): Promise<number> {
  await walletRegistry
    .connect(stakingProvider)
    .registerOperator(await operator.getAddress())

  await walletRegistry.connect(operator).joinSortitionPool()

  const operatorID = await sortitionPool.getOperatorID(
    await operator.getAddress()
  )

  return operatorID
}

export async function performEcdsaDkg(
  hre: HardhatRuntimeEnvironment,
  walletRegistry: WalletRegistry,
  groupPublicKey: BytesLike,
  startBlock: number
): Promise<{
  approveDkgResultTx: ContractTransactionResponse
  walletMembers: Operators
}> {
  const { helpers } = hre

  const {
    signers: walletMembers,
    dkgResult,
    submitter,
    submitDkgResultTx: dkgResultSubmissionTx,
  } = await signAndSubmitDkgResult(
    hre,
    walletRegistry,
    groupPublicKey,
    startBlock
  )

  await helpers.time.mineBlocksTo(
    dkgResultSubmissionTx.blockNumber +
      Number((
        await walletRegistry.dkgParameters()
      ).resultChallengePeriodLength)
  )

  const approveDkgResultTx = await walletRegistry
    .connect(submitter)
    .approveDkgResult(dkgResult)

  return { approveDkgResultTx, walletMembers }
}

export async function updateWalletRegistryDkgResultChallengePeriodLength(
  hre: HardhatRuntimeEnvironment,
  walletRegistry: WalletRegistry,
  governance: Signer,
  dkgResultChallengePeriodLength: BigNumberish
): Promise<void> {
  const { deployments, ethers, helpers } = hre

  const walletRegistryGovernance = await ethers.getContractAt(
    (
      await deployments.getArtifact("WalletRegistryGovernance")
    ).abi,
    await walletRegistry.governance()
  )

  await walletRegistryGovernance
    .connect(governance)
    .beginDkgResultChallengePeriodLengthUpdate(dkgResultChallengePeriodLength)

  await helpers.time.increaseTime(
    await walletRegistryGovernance.governanceDelay()
  )

  await walletRegistryGovernance
    .connect(governance)
    .finalizeDkgResultChallengePeriodLengthUpdate()
}

async function selectGroup(
  hre: HardhatRuntimeEnvironment,
  walletRegistry: WalletRegistry
): Promise<Operators> {
  const { ethers } = hre

  const sortitionPool = (await ethers.getContractAt(
    "SortitionPool",
    await walletRegistry.sortitionPool()
  )) as SortitionPool

  const identifiers: number[] = await walletRegistry.selectGroup()

  const addresses = await sortitionPool.getIDOperators(identifiers)

  return new Operators(
    ...(await Promise.all(
      identifiers.map(
        async (identifier, i): Promise<Operator> => ({
          id: identifier,
          signer: await ethers.getSigner(addresses[i]),
          stakingProvider: await walletRegistry.operatorToStakingProvider(
            addresses[i]
          ),
        })
      )
    ))
  )
}

export async function produceOperatorInactivityClaim(
  hre: HardhatRuntimeEnvironment,
  walletID: BytesLike,
  signers: Operators,
  nonce: number,
  groupPubKey: BytesLike,
  heartbeatFailed: boolean,
  inactiveMembersIndices: number[],
  numberOfSignatures: number
): Promise<ClaimStruct> {
  const { ethers } = hre
  const messageHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256", "bytes", "uint8[]", "bool"],
      [
        hardhatNetworkId,
        nonce,
        groupPubKey,
        inactiveMembersIndices,
        heartbeatFailed,
      ]
    )
  )

  const signingMembersIndices: number[] = []
  const signatures: string[] = []

  for (let i = 0; i < signers.length; i++) {
    if (signatures.length === numberOfSignatures) {
      // eslint-disable-next-line no-continue
      continue
    }

    const signerIndex: number = i + 1
    signingMembersIndices.push(signerIndex)

    const signature = await signers[i].signer.signMessage(
      ethers.getBytes(messageHash)
    )

    signatures.push(signature)
  }

  return {
    walletID,
    inactiveMembersIndices,
    heartbeatFailed,
    signatures: ethers.concat(signatures),
    signingMembersIndices,
  }
}

interface DkgResult {
  submitterMemberIndex: number
  groupPubKey: BytesLike
  misbehavedMembersIndices: number[]
  signatures: string
  signingMembersIndices: number[]
  members: number[]
  membersHash: string
}

type Operator = {
  id: number
  signer: HardhatEthersSigner
  stakingProvider: string
}

export class Operators extends Array<Operator> {
  getIds(): number[] {
    return this.map((operator) => operator.id)
  }

  getSigners(): HardhatEthersSigner[] {
    return this.map((operator) => operator.signer)
  }
}

const noMisbehaved: number[] = []

async function signAndSubmitDkgResult(
  hre: HardhatRuntimeEnvironment,
  walletRegistry: WalletRegistry,
  groupPublicKey: BytesLike,
  startBlock: number,
  misbehavedIndices = noMisbehaved
): Promise<{
  signers: Operators
  dkgResult: DkgResult
  submitter: HardhatEthersSigner
  submitDkgResultTx: ContractTransactionResponse
}> {
  const signers = await selectGroup(hre, walletRegistry)

  const submitterIndex = 1

  const { dkgResult } = await signDkgResult(
    hre,
    signers,
    groupPublicKey,
    misbehavedIndices,
    startBlock,
    submitterIndex
  )

  const submitter = signers[submitterIndex - 1].signer

  const submitDkgResultTx = await walletRegistry
    .connect(submitter)
    .submitDkgResult(dkgResult)

  return {
    signers,
    dkgResult,
    submitter,
    submitDkgResultTx,
  }
}

async function signDkgResult(
  hre: HardhatRuntimeEnvironment,
  signers: Operators,
  groupPublicKey: BytesLike,
  misbehavedMembersIndices: number[],
  startBlock: number,
  submitterIndex: number
): Promise<{
  dkgResult: DkgResult
  signingMembersIndices: number[]
  signaturesBytes: string
}> {
  const { ethers } = hre

  const numberOfSignatures: number = signers.length / 2 + 1

  const resultHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "bytes", "uint8[]", "uint256"],
      [hardhatNetworkId, groupPublicKey, misbehavedMembersIndices, startBlock]
    )
  )

  const members: number[] = []
  const signingMembersIndices: number[] = []
  const signatures: string[] = []
  for (let i = 0; i < signers.length; i++) {
    const { id, signer: ethersSigner } = signers[i]
    members.push(id)

    if (signatures.length === numberOfSignatures) {
      // eslint-disable-next-line no-continue
      continue
    }

    const signerIndex: number = i + 1

    signingMembersIndices.push(signerIndex)

    const signature = await ethersSigner.signMessage(
      ethers.getBytes(resultHash)
    )

    signatures.push(signature)
  }

  const signaturesBytes: string = ethers.concat(signatures)

  const dkgResult: DkgResult = {
    submitterMemberIndex: submitterIndex,
    groupPubKey: groupPublicKey,
    misbehavedMembersIndices,
    signatures: signaturesBytes,
    signingMembersIndices,
    members,
    membersHash: hashDKGMembers(hre, members, misbehavedMembersIndices),
  }

  return { dkgResult, signingMembersIndices, signaturesBytes }
}

function hashDKGMembers(
  hre: HardhatRuntimeEnvironment,
  members: number[],
  misbehavedMembersIndices?: number[]
): string {
  const { ethers } = hre

  if (misbehavedMembersIndices && misbehavedMembersIndices.length > 0) {
    const activeDkgMembers = [...members]
    for (let i = 0; i < misbehavedMembersIndices.length; i++) {
      if (misbehavedMembersIndices[i] !== 0) {
        activeDkgMembers.splice(misbehavedMembersIndices[i] - i - 1, 1)
      }
    }

    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["uint32[]"], [activeDkgMembers])
    )
  }

  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["uint32[]"], [members])
  )
}
