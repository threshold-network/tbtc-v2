module.exports = {
  extends: ["google", "prettier"],
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint", "no-only-tests", "prettier"],
  rules: {
    "new-cap": [
      "error",
      {
        capIsNewExceptions: ["BN"],
      },
    ],
    "require-jsdoc": 0,
    "no-only-tests/no-only-tests": "error",
    "prettier/prettier": [
      "error",
      {
        semi: false,
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
