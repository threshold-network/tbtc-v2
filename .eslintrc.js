module.exports = {
  root: true,
  env: {
    node: true,
    es2020: true,
  },
  extends: ["eslint:recommended"],
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: "module",
  },
  rules: {
    "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "no-console": "warn",
    "prefer-const": "error",
    "no-var": "error",
  },
  ignorePatterns: [
    "node_modules/",
    "build/",
    "cache/",
    "typechain/",
    "export/",
    "external/",
  ],
}
