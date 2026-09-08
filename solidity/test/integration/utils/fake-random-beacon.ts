import { ethers } from "hardhat"
import type { BigNumberish } from "ethers"
import type { IRandomBeacon, WalletRegistry } from "../../../typechain"
import { createMock } from "../../helpers/mock"
import type { Mock } from "../../helpers/mock"

// eslint-disable-next-line import/prefer-default-export
export async function fakeRandomBeacon(
  walletRegistry: WalletRegistry
): Promise<Mock<IRandomBeacon>> {
  const randomBeacon = await createMock<IRandomBeacon>("IRandomBeacon", {
    address: await walletRegistry.callStatic.randomBeacon(),
  })

  await (
    await ethers.getSigners()
  )[0].sendTransaction({
    to: randomBeacon.address,
    value: ethers.utils.parseEther("1000"),
  })

  return randomBeacon
}

export async function produceRelayEntry(
  walletRegistry: WalletRegistry,
  randomBeacon: Mock<IRandomBeacon>
): Promise<BigNumberish> {
  const relayEntry: BigNumberish = ethers.utils.randomBytes(32)

  // eslint-disable-next-line no-underscore-dangle
  await walletRegistry
    .connect(randomBeacon.wallet)
    .__beaconCallback(relayEntry, 0)

  return relayEntry
}
