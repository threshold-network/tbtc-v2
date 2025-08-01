import { ethers } from "hardhat"

async function main() {
  const proxyAddress = "0xF51e9269A251901F60F2F73E27E95dB7cb21c233"
  const implementationAddress = "0x98aF01b95f1DE886461213bfB74F91fc782b1948"

  console.log("=== PROXY vs IMPLEMENTATION COMPARISON ===\n")

  // Check PROXY contract (where state is stored)
  console.log("🔵 PROXY CONTRACT:", proxyAddress)
  const proxyContract = await ethers.getContractAt(
    "LockReleaseTokenPoolUpgradeable",
    proxyAddress
  )

  const proxyRouter = await proxyContract.s_router()
  const proxyRmnProxy = await proxyContract.s_rmnProxy()
  const proxyToken = await proxyContract.s_token()
  const proxyChainId = await proxyContract.s_supportedRemoteChainId()

  console.log("  Router address:", proxyRouter)
  console.log("  RMN Proxy:", proxyRmnProxy)
  console.log("  Token:", proxyToken)
  console.log("  Supported Chain ID:", proxyChainId.toString())

  if (proxyRouter === "0x0000000000000000000000000000000000000000") {
    console.log("  ❌ Router is ZERO ADDRESS!")
  } else {
    console.log("  ✅ Router is properly set!")
  }

  console.log("\n🔴 IMPLEMENTATION CONTRACT:", implementationAddress)
  const implContract = await ethers.getContractAt(
    "LockReleaseTokenPoolUpgradeable",
    implementationAddress
  )

  const implRouter = await implContract.s_router()
  const implRmnProxy = await implContract.s_rmnProxy()
  const implToken = await implContract.s_token()
  const implChainId = await implContract.s_supportedRemoteChainId()

  console.log("  Router address:", implRouter)
  console.log("  RMN Proxy:", implRmnProxy)
  console.log("  Token:", implToken)
  console.log("  Supported Chain ID:", implChainId.toString())

  if (implRouter === "0x0000000000000000000000000000000000000000") {
    console.log("  ❌ Router is ZERO ADDRESS (EXPECTED for implementation!)")
  } else {
    console.log("  ✅ Router is set (unexpected for implementation)")
  }

  console.log("\n=== SUMMARY ===")
  console.log("✅ Always check the PROXY contract for actual values!")
  console.log("✅ Implementation contracts only contain logic, not state!")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
