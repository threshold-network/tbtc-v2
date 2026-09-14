// Shared ESLint baseline for cross-chain/bob and typescript.
// Rules are vendored from eslint-config-keep@0c27ade54e725f980e971c3d91ea88bab76b2330
// (extends google+prettier, parser/plugins, require-jsdoc, no-only-tests, prettier/prettier),
// plus the valid-jsdoc block both consumers carried locally.
// new-cap is intentionally NOT included here: consumers layer their own
// capIsNewExceptions list on top because it differs per consumer.
module.exports = {
  extends: ["google", "prettier"],
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint", "no-only-tests", "prettier"],
  rules: {
    "require-jsdoc": 0,
    "no-only-tests/no-only-tests": "error",
    "prettier/prettier": ["error", require("./prettier-base")],
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
