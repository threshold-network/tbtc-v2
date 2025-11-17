/* eslint-disable no-console */
import hre from "hardhat"

async function verifyContract(opts: any) {
  try {
    await hre.run("verify:verify", opts)
    console.log("✅ Verified:", opts.address, opts.contract || "(auto)")
  } catch (e: any) {
    const msg = e?.message || String(e)
    console.log("❌ Verify failed for", opts.address, "\n  ", msg)
  }
}

async function main() {
  const { deployments } = hre
  // Addresses
  const bridgeProxy = process.env.BRIDGE_ADDRESS || "0x9b1a7fE5a16A15F2f9475C5B231750598b113403"
  const bgp = await deployments.getOrNull("BridgeGovernanceParameters")
  const bg = await deployments.getOrNull("BridgeGovernance")

  if (!bgp?.address || !bg?.address) {
    console.log("BridgeGovernance/Parameters deployments not found in cache. Falling back to env.")
  }

  const bgpAddress = bgp?.address || process.env.BRIDGE_GOVERNANCE_PARAMETERS_ADDRESS
  const bgAddress = bg?.address || process.env.BRIDGE_GOVERNANCE_ADDRESS

  if (!bgpAddress || !bgAddress) {
    throw new Error("Missing BridgeGovernance or Parameters address; set env overrides if needed.")
  }

  // 1) Verify BridgeGovernanceParameters (no args)
  await verifyContract({
    address: bgpAddress,
    contract: "contracts/bridge/BridgeGovernanceParameters.sol:BridgeGovernanceParameters",
  })

  // 2) Verify BridgeGovernance (args: Bridge proxy, governanceDelay=60 on Sepolia)
  const governanceDelay = process.env.GOVERNANCE_DELAY || "60"
  await verifyContract({
    address: bgAddress,
    contract: "contracts/bridge/BridgeGovernance.sol:BridgeGovernance",
    constructorArguments: [bridgeProxy, Number(governanceDelay)],
  })

  // 3) Verify Bridge implementation (with library map)
  const impl = process.env.BRIDGE_IMPLEMENTATION || "0x32498B20c542eAd1207006bdAe8D9D0085c6cd39"
  const libs = {
    Deposit: process.env.DEPOSIT_LIB_ADDRESS || "0x5De0E0a11ffb13D36cBD9eF67c72D80C1C2da24D",
    DepositSweep: process.env.DEPOSITSWEEP_LIB_ADDRESS || "0xA10A61AC9c46D4e2D3E5958d5D1dEbf825b5EE24",
    Redemption: process.env.REDEMPTION_LIB_ADDRESS || "0xD36de53d14B0BBBC51538057FFE1Ea6bFD1a7766",
    Wallets: process.env.WALLETS_LIB_ADDRESS || "0xC018a123bF5E86D74364f8F8C82d5AE0fAeDa7A7",
    Fraud: process.env.FRAUD_LIB_ADDRESS || "0x8538764AA7aC6b0603204244009F08549eF490b5",
    MovingFunds: process.env.MOVINGFUNDS_LIB_ADDRESS || "0xEb31C47480AA51Fb4d77009712a91CC387c61995",
  }
  await verifyContract({
    address: impl,
    contract: "contracts/bridge/Bridge.sol:Bridge",
    libraries: libs,
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

