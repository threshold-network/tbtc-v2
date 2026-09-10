const base = require("../../config/eslint-base")

module.exports = {
  ...base,
  rules: {
    ...base.rules,
    "new-cap": [
      "error",
      {
        capIsNewExceptions: ["BN"],
      },
    ],
  },
}
