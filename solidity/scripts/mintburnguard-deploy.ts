import hre from "hardhat"
import deployMintBurnGuard from "../deploy/44_deploy_mint_burn_guard"

async function main() {
  await deployMintBurnGuard(hre)
}

main().catch((error) => {
  console.error("MintBurnGuard deployment failed:", error)
  process.exitCode = 1
})
