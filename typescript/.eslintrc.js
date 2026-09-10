module.exports = {
  extends: ["google", "prettier"],
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint", "no-only-tests", "prettier"],
  rules: {
    "require-jsdoc": 0,
    "no-only-tests/no-only-tests": "error",
    "prettier/prettier": [
      "error",
      {
        semi: false,
      },
    ],
    // ethers: BigNumber.from and contract filter factories (EventName) are not constructors
    "new-cap": [
      "error",
      {
        capIsNewExceptions: ["BN", "BigNumber", "DkgResultSubmitted"],
      },
    ],
    "valid-jsdoc": [
      "error",
      {
        prefer: { return: "returns" },
        requireParamType: false,
        requireReturnType: false,
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
