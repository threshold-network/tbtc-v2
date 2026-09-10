// Shared base extracted from the vendored eslint-config-keep content that was
// previously duplicated verbatim across cross-chain/bob and typescript.
// Consumers require() this by relative path and layer their own
// `new-cap.capIsNewExceptions` list on top (it differs per consumer).
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
