module.exports = {
  extends: ["eslint-config-keep"],
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  rules: {
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
