module.exports = {
  extends: ["eslint-config-keep"],
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  rules: {
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
}
