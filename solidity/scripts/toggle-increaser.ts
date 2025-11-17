/* eslint-disable no-console */
import hre from "hardhat"

async function main() {
  const { deployments, ethers } = hre

  const bridgeDep = await deployments.getOrNull("Bridge")
  const bridgeAddr = process.env.BRIDGE_ADDRESS || bridgeDep?.address
  if (!bridgeAddr) throw new Error("BRIDGE_ADDRESS not set and Bridge not in cache")

  const govDep = await deployments.getOrNull("BridgeGovernance")
  const govAddr = process.env.BRIDGE_GOVERNANCE_ADDRESS || govDep?.address
  if (!govAddr) throw new Error("BridgeGovernance address not found; set BRIDGE_GOVERNANCE_ADDRESS or deploy it")

  const testAddr =
    process.env.TEST_INCREASER || "0x0000000000000000000000000000000000000001"

  const pk = process.env.BRIDGE_GOVERNANCE_PK
  if (!pk) throw new Error("BRIDGE_GOVERNANCE_PK is required (new governance owner key)")
  const provider = ethers.provider
  const signer = new ethers.Wallet(pk, provider)

  const bridge = new ethers.Contract(
    bridgeAddr,
    [
      "function authorizedBalanceIncreasers(address) view returns (bool)",
    ],
    provider
  )

  const gov = new ethers.Contract(
    govAddr,
    [
      "function owner() view returns (address)",
      "function setAuthorizedBalanceIncreaser(address,bool)",
    ],
    signer
  )

  const owner = await gov.owner()
  const signerAddr = await signer.getAddress()
  if (owner.toLowerCase() !== signerAddr.toLowerCase()) {
    throw new Error(
      `Signer ${signerAddr} is not BridgeGovernance owner (${owner}); cannot toggle`
    )
  }

  const pre = await bridge.authorizedBalanceIncreasers(testAddr)
  console.log(`pre authorized(${testAddr}):`, pre)

  let gas = undefined as any
  try {
    gas = await gov.estimateGas.setAuthorizedBalanceIncreaser(testAddr, true)
  } catch {
    gas = ethers.BigNumber.from(200000)
  }
  const authTx = await gov.setAuthorizedBalanceIncreaser(testAddr, true, {
    gasLimit: gas.mul(12).div(10),
  })
  console.log("authorize tx:", authTx.hash)
  await authTx.wait(1)
  const mid = await bridge.authorizedBalanceIncreasers(testAddr)
  console.log(`post-authorize authorized(${testAddr}):`, mid)

  try {
    gas = await gov.estimateGas.setAuthorizedBalanceIncreaser(testAddr, false)
  } catch {
    gas = ethers.BigNumber.from(200000)
  }
  const deauthTx = await gov.setAuthorizedBalanceIncreaser(testAddr, false, {
    gasLimit: gas.mul(12).div(10),
  })
  console.log("deauthorize tx:", deauthTx.hash)
  await deauthTx.wait(1)
  const post = await bridge.authorizedBalanceIncreasers(testAddr)
  console.log(`post-deauthorize authorized(${testAddr}):`, post)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
