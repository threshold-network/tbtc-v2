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

// no-new-func handles direct Function calls; keep the inherited qualified forms.
const qualifiedFunctionConstructor = {
  selector:
    ':matches(CallExpression, NewExpression)[callee.type="MemberExpression"][callee.object.type="Identifier"][callee.object.name=/^(global|globalThis|window)$/]:matches([callee.computed=false][callee.property.name="Function"], [callee.computed=true][callee.property.value="Function"])',
  message: "The Function constructor is eval.",
}

// A failing assertion inside a try block is caught by the matching catch.
// When the catch then checks the error message, the assertion's own message
// usually matches, so a promise that never rejects still passes the test.
const expectFailInTry = {
  selector:
    'TryStatement > BlockStatement.block CallExpression[callee.type="MemberExpression"][callee.object.name="expect"][callee.property.name="fail"]',
  message:
    "expect.fail inside a try block is caught by its own catch. Record the error in the catch and assert after the try.",
}

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
      // Registered under the legacy "import" alias so existing repo-wide
      // inline eslint-disable comments (e.g. "import/prefer-default-export")
      // keep resolving; only settings below use the plugin's own hardcoded
      // "import-x/*" namespace, which is unaffected by this alias.
      import: importPlugin,
      "no-only-tests": noOnlyTests,
    },
    settings: {
      // Resolution locates files; these settings also enable TS export-map traversal.
      ...importPlugin.flatConfigs.typescript.settings,
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
    rules: {
      ...jsRules,
      "no-restricted-syntax": [
        ...coreRules["no-restricted-syntax"],
        qualifiedFunctionConstructor,
      ],
    },
  },
  {
    files: ["**/*.cjs", "deploy-patches/**/*.js"],
    languageOptions: { sourceType: "commonjs" },
  },
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      ...testRules,
      "no-only-tests/no-only-tests": "error",
      "no-restricted-syntax": [
        ...coreRules["no-restricted-syntax"],
        expectFailInTry,
      ],
    },
  },
  {
    files: ["deploy-patches/**/*.js"],
    rules: {
      ...deployPatchRules,
      "no-restricted-syntax": ["error", qualifiedFunctionConstructor],
    },
  },
]
