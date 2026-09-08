const tsParser = require("@typescript-eslint/parser")
const tsPlugin = require("@typescript-eslint/eslint-plugin")
const importPlugin = require("eslint-plugin-import-x")
const {
  createTypeScriptImportResolver,
} = require("eslint-import-resolver-typescript")
const noOnlyTests = require("eslint-plugin-no-only-tests")
const globals = require("globals")
const {
  coreRules,
  tsRules,
  jsRules,
  testRules,
  deployPatchRules,
} = require("./eslint.rules.cjs")

const root = __dirname

module.exports = [
  {
    ignores: [
      "artifacts/**",
      "build/**",
      "cache/**",
      "deployments/**",
      "export/**",
      "hardhat-dependency-compiler/**",
      "typechain/**",
      "export.json",
      ".openzeppelin/**",
      ".yarn/**",
      ".hardhat/**",
    ],
  },
  {
    files: ["**/*.{ts,js,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: { ...globals.node, ...globals.mocha },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      import: importPlugin,
      "no-only-tests": noOnlyTests,
    },
    settings: {
      "import-x/resolver-next": [
        createTypeScriptImportResolver({
          project: `${root}/tsconfig.eslint.json`,
        }),
      ],
    },
    rules: coreRules,
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: root,
      },
    },
    rules: tsRules,
  },
  {
    files: ["**/*.{js,cjs}"],
    rules: jsRules,
  },
  {
    files: ["**/*.cjs", "deploy-patches/**/*.js"],
    languageOptions: { sourceType: "commonjs" },
  },
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: { ...testRules, "no-only-tests/no-only-tests": "error" },
  },
  {
    files: ["deploy-patches/**/*.js"],
    rules: deployPatchRules,
  },
]
