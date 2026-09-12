module.exports = {
  ...require("../../config/prettier-base"),
  overrides: [
    {
      files: "*.sol",
      options: {
        tabWidth: 4,
      },
    },
  ],
}
