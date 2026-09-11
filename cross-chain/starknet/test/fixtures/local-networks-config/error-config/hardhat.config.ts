import { HardhatUserConfig } from "hardhat/config"
import "../../../../local-networks-config"

const config: HardhatUserConfig = {
  solidity: "0.8.17",
  paths: {
    root: __dirname,
  },
  networks: {
    sepolia: {
      url: "https://sepolia.example.invalid",
      accounts: [
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      ],
      chainId: 11155111,
    },
  },
  localNetworksConfig: "./nonexistent-networks.js",
}

export default config
