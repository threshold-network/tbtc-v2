import type { BigNumberish, Contract, Signer } from "ethers"
import { HardhatRuntimeEnvironment } from "hardhat/types"

export async function stake(
  hre: HardhatRuntimeEnvironment,
  t: TestERC20,
  staking: Contract,
  stakeAmount: BigNumberish,
  owner: Signer,
  stakingProvider: string,
  beneficiary: string,
  authorizer: string
): Promise<void> {
  const { helpers } = hre
  const { deployer } = await helpers.signers.getNamedSigners()

  await t.connect(deployer).mint(await owner.getAddress(), stakeAmount)
  await t.connect(owner).approve(staking.address, stakeAmount)

  await staking
    .connect(owner)
    .stake(stakingProvider, beneficiary, authorizer, stakeAmount)
}

export async function authorizeApplication(
  staking: Contract,
  application: string,
  authorizer: Signer,
  stakingProvider: string,
  stakeAmount: BigNumberish
): Promise<void> {
  await staking
    .connect(authorizer)
    .increaseAuthorization(stakingProvider, application, stakeAmount)
}
