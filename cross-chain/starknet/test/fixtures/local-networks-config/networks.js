module.exports = {
  defaultConfig: {
    gasPrice: 20000000000,
    tags: ["project-local-tag"],
    deploy: ["project-local-deploy-script"],
  },
  networks: {
    sepolia: {
      gasPrice: 30000000000,
      tags: ["project-local-sepolia-tag"],
      deploy: ["project-local-sepolia-deploy"],
      from: "0xprojectlocalfrom",
    },
    // Network only in project-local config (not in hardhat.config.ts networks)
    localOnly: {
      url: "http://localOnly.example.invalid",
      accounts: [
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      ],
      gasPrice: 40000000000,
      tags: ["project-local-only-tag"],
      deploy: ["project-local-only-deploy"],
    },
    // Network in both project-local config and home config (absent from hardhat.config.ts)
    bothLocalAndHome: {
      url: "http://bothLocalAndHome.example.invalid",
      accounts: [
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      ],
      gasPrice: 50000000000,
      tags: ["project-local-both-tag"],
      deploy: ["project-local-both-deploy"],
    },
  },
}
