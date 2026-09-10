const base = require("../config/eslint-base")

module.exports = {
  ...base,
  rules: {
    ...base.rules,
    // ethers: BigNumber.from and contract filter factories (EventName) are not constructors
    "new-cap": [
      "error",
      {
        capIsNewExceptions: ["BN", "BigNumber", "DkgResultSubmitted"],
      },
    ],
  },
  overrides: [
    {
      files: ["src/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["ethers", "ethers/**"],
                message:
                  "ethers is a devDependency only. Use scoped @ethersproject/* packages instead.",
              },
            ],
          },
        ],
      },
    },
  ],
}
