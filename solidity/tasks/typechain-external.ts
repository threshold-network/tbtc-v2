import path from "path"
import { subtask } from "hardhat/config"
import { TASK_TYPECHAIN_GENERATE_TYPES } from "@typechain/hardhat/dist/constants"
import { runTypeChain } from "typechain"

// Generate ethers v6 types from the same published ABIs used by the deploy
// fixtures. Compiling these dependencies would change the exported artifacts.
const externalContracts = {
  TokenStaking:
    "@threshold-network/solidity-contracts/export/artifacts/contracts/staking/TokenStaking.sol/TokenStaking.json",
  RandomBeacon:
    "@keep-network/random-beacon/export/artifacts/contracts/RandomBeacon.sol/RandomBeacon.json",
  RandomBeaconGovernance:
    "@keep-network/random-beacon/export/artifacts/contracts/RandomBeaconGovernance.sol/RandomBeaconGovernance.json",
  WalletRegistryGovernance:
    "@keep-network/ecdsa/export/artifacts/contracts/WalletRegistryGovernance.sol/WalletRegistryGovernance.json",
}

subtask(TASK_TYPECHAIN_GENERATE_TYPES).setAction(
  async (args, hre, runSuper) => {
    const result = await runSuper(args)
    await Promise.all(
      Object.entries(externalContracts).map(async ([name, artifact]) => {
        const file = require.resolve(artifact)
        return runTypeChain({
          cwd: hre.config.paths.root,
          allFiles: [file],
          filesToProcess: [file],
          inputDir: path.dirname(path.dirname(file)),
          outDir: path.join(hre.config.typechain.outDir, "external", name),
          target: "ethers-v6",
        })
      })
    )
    return result
  }
)
