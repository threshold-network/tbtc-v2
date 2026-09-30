module.exports = {
  semi: false,
  trailingComma: "es5",
  plugins: ["prettier-plugin-solidity", "prettier-plugin-sh"],
  overrides: [
    {
      files: "*.sol",
      options: {
        tabWidth: 4,
      },
    },
  ],
}
