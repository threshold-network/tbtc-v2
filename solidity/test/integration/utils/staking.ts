import type { AddressLike, BigNumberish, Signer } from "ethers"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import type { TestERC20 } from "../../../typechain"
import type { TokenStaking } from "../../../typechain/external/TokenStaking"

export async function stake(
  hre: HardhatRuntimeEnvironment,
  t: TestERC20,
  staking: TokenStaking,
  stakeAmount: BigNumberish,
  owner: Signer,
  stakingProvider: string,
  beneficiary: string,
  authorizer: string
): Promise<void> {
  const { helpers } = hre
  const { deployer } = await helpers.signers.getNamedSigners()

  await t.connect(deployer).mint(await owner.getAddress(), stakeAmount)
  await t.connect(owner).approve(staking.target, stakeAmount)

  await staking
    .connect(owner)
    .stake(stakingProvider, beneficiary, authorizer, stakeAmount)
}

export async function authorizeApplication(
  staking: TokenStaking,
  application: AddressLike,
  authorizer: Signer,
  stakingProvider: string,
  stakeAmount: BigNumberish
): Promise<void> {
  await staking
    .connect(authorizer)
    .increaseAuthorization(stakingProvider, application, stakeAmount)
}
