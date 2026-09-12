// Preserve the non-formatting policy previously resolved from @thesis-co/eslint-config.
// Formatting is checked by Prettier; this package contains no React/JSX source.
// Source: @thesis-co/eslint-config 0.1.0, commit 778365bbebb6b056bf973d25c57b8b466d21cbcf
module.exports = {
  coreRules: {
    "no-plusplus": [
      "error",
      {
        allowForLoopAfterthoughts: true,
      },
    ],
    "no-restricted-properties": [
      "error",
      {
        object: "waffle",
        property: "loadFixture",
        message:
          "waffle.loadFixture discards the boolean evm_revert returns and can hand back stale fixture data. Use loadFixture from '../helpers/fixture' (or deployments.createFixture for hardhat-deploy fixtures) instead.",
      },
    ],
    "no-param-reassign": [
      "error",
      {
        props: true,
        ignorePropertyModificationsFor: [
          "acc",
          "accumulator",
          "e",
          "ctx",
          "context",
          "req",
          "request",
          "res",
          "response",
          "$scope",
          "staticContext",
        ],
        ignorePropertyModificationsForRegex: ["^immer"],
      },
    ],
    "no-var": ["error"],
    "prefer-const": [
      "error",
      {
        destructuring: "any",
        ignoreReadBeforeAssign: true,
      },
    ],
    "prefer-rest-params": ["error"],
    "prefer-spread": ["error"],
    "import/no-unresolved": [
      "error",
      {
        commonjs: true,
        caseSensitive: true,
        caseSensitiveStrict: false,
      },
    ],
    "import/namespace": ["error"],
    "import/default": ["error"],
    "import/export": ["error"],
    "import/no-named-as-default": ["warn"],
    "import/no-named-as-default-member": ["warn"],
    "import/no-duplicates": ["warn"],
    "import/extensions": [
      "error",
      "ignorePackages",
      {
        js: "never",
        mjs: "never",
        jsx: "never",
        ts: "never",
        tsx: "never",
      },
    ],
    "no-underscore-dangle": [
      "error",
      {
        allow: [],
        allowAfterThis: false,
        allowAfterSuper: false,
        enforceInMethodNames: true,
        allowAfterThisConstructor: false,
        allowFunctionParams: true,
      },
    ],
    "class-methods-use-this": [
      "error",
      {
        exceptMethods: [],
      },
    ],
    strict: ["error", "never"],
    "import/no-mutable-exports": ["error"],
    "import/no-amd": ["error"],
    "import/first": ["error"],
    "import/order": [
      "error",
      {
        groups: [["builtin", "external", "internal"]],
        warnOnUnassignedImports: false,
      },
    ],
    "import/newline-after-import": ["error"],
    "import/prefer-default-export": ["error"],
    "import/no-absolute-path": ["error"],
    "import/no-dynamic-require": ["error"],
    "import/no-webpack-loader-syntax": ["error"],
    "import/no-named-default": ["error"],
    "import/no-self-import": ["error"],
    "import/no-cycle": [
      "error",
      {
        maxDepth: "\u221e",
        ignoreExternal: true,
      },
    ],
    "import/no-useless-path-segments": [
      "error",
      {
        commonjs: true,
      },
    ],
    "arrow-body-style": [
      "error",
      "as-needed",
      {
        requireReturnForObjectLiteral: false,
      },
    ],
    "no-class-assign": ["error"],
    "no-useless-computed-key": ["error"],
    "no-useless-rename": [
      "error",
      {
        ignoreDestructuring: false,
        ignoreImport: false,
        ignoreExport: false,
      },
    ],
    "object-shorthand": [
      "error",
      "always",
      {
        ignoreConstructors: false,
        avoidQuotes: true,
      },
    ],
    "prefer-arrow-callback": [
      "error",
      {
        allowNamedFunctions: false,
        allowUnboundThis: true,
      },
    ],
    "prefer-destructuring": [
      "error",
      {
        VariableDeclarator: {
          array: false,
          object: true,
        },
        AssignmentExpression: {
          array: true,
          object: false,
        },
      },
      {
        enforceForRenamedProperties: false,
      },
    ],
    "prefer-numeric-literals": ["error"],
    "prefer-template": ["error"],
    "require-yield": ["error"],
    "symbol-description": ["error"],
    "no-delete-var": ["error"],
    "no-label-var": ["error"],
    "no-restricted-globals": [
      "error",
      {
        name: "isFinite",
        message:
          "Use Number.isFinite instead https://github.com/airbnb/javascript#standard-library--isfinite",
      },
      {
        name: "isNaN",
        message:
          "Use Number.isNaN instead https://github.com/airbnb/javascript#standard-library--isnan",
      },
    ],
    "no-shadow-restricted-names": ["error"],
    "no-undef-init": ["error"],
    "func-names": ["warn"],
    "no-bitwise": ["error"],
    "no-continue": ["error"],
    "no-lonely-if": ["error"],
    "no-multi-assign": ["error"],
    "no-nested-ternary": ["error"],
    "no-object-constructor": ["error"],
    "no-restricted-syntax": [
      "error",
      {
        selector: "ForInStatement",
        message:
          "for..in loops iterate over the entire prototype chain, which is virtually never what you want. Use Object.{keys,values,entries}, and iterate over the resulting array.",
      },
      {
        selector: "ForOfStatement",
        message:
          "iterators/generators require regenerator-runtime, which is too heavyweight for this guide to allow them. Separately, loops should be avoided in favor of array iterations.",
      },
      {
        selector: "LabeledStatement",
        message:
          "Labels are a form of GOTO; using them makes code confusing and hard to maintain and understand.",
      },
      {
        selector: "WithStatement",
        message:
          "`with` is disallowed in strict mode because it makes code impossible to predict and optimize.",
      },
    ],
    "no-unneeded-ternary": [
      "error",
      {
        defaultAssignment: false,
      },
    ],
    "one-var": ["error", "never"],
    "operator-assignment": ["error", "always"],
    "prefer-object-spread": ["error"],
    "global-require": ["error"],
    "for-direction": ["error"],
    "no-async-promise-executor": ["error"],
    "no-await-in-loop": ["error"],
    "no-compare-neg-zero": ["error"],
    "no-cond-assign": ["error", "always"],
    "no-console": ["warn"],
    "no-constant-condition": ["warn"],
    "no-control-regex": ["error"],
    "no-debugger": ["error"],
    "no-duplicate-case": ["error"],
    "no-empty": ["error"],
    "no-empty-character-class": ["error"],
    "no-ex-assign": ["error"],
    "no-extra-boolean-cast": ["error"],
    "no-inner-declarations": ["error"],
    "no-invalid-regexp": ["error"],
    "no-irregular-whitespace": ["error"],
    "no-misleading-character-class": ["error"],
    "no-prototype-builtins": ["error"],
    "no-regex-spaces": ["error"],
    "no-sparse-arrays": ["error"],
    "no-template-curly-in-string": ["error"],
    "no-unsafe-finally": ["error"],
    "use-isnan": ["error"],
    "array-callback-return": [
      "error",
      {
        allowImplicit: true,
        checkForEach: false,
      },
    ],
    "block-scoped-var": ["error"],
    "consistent-return": ["error"],
    "default-case": [
      "error",
      {
        commentPattern: "^no default$",
      },
    ],
    eqeqeq: [
      "error",
      "always",
      {
        null: "ignore",
      },
    ],
    "guard-for-in": ["error"],
    "max-classes-per-file": ["error", 1],
    "no-alert": ["warn"],
    "no-caller": ["error"],
    "no-case-declarations": ["error"],
    "no-else-return": [
      "error",
      {
        allowElseIf: false,
      },
    ],
    "no-empty-pattern": ["error"],
    "no-eval": ["error"],
    "no-extend-native": ["error"],
    "no-extra-bind": ["error"],
    "no-extra-label": ["error"],
    "no-fallthrough": ["error"],
    "no-global-assign": [
      "error",
      {
        exceptions: [],
      },
    ],
    "no-iterator": ["error"],
    "no-labels": [
      "error",
      {
        allowLoop: false,
        allowSwitch: false,
      },
    ],
    "no-lone-blocks": ["error"],
    "no-multi-str": ["error"],
    "no-new": ["error"],
    "no-new-wrappers": ["error"],
    "no-octal": ["error"],
    "no-octal-escape": ["error"],
    "no-proto": ["error"],
    "no-return-assign": ["error", "always"],
    "no-script-url": ["error"],
    "no-self-assign": [
      "error",
      {
        props: true,
      },
    ],
    "no-self-compare": ["error"],
    "no-sequences": ["error"],
    "no-unused-labels": ["error"],
    "no-useless-catch": ["error"],
    "no-useless-concat": ["error"],
    "no-useless-escape": ["error"],
    "no-useless-return": ["error"],
    "no-void": ["error"],
    "no-with": ["error"],
    "prefer-promise-reject-errors": [
      "error",
      {
        allowEmptyReject: true,
      },
    ],
    radix: ["error"],
    "vars-on-top": ["error"],
    yoda: ["error"],
    "new-cap": "off",
    "import/no-extraneous-dependencies": "off",
    "no-use-before-define": "off",
    "no-unused-vars": "off",
    "no-shadow": "off",
  },
  tsRules: {
    "@typescript-eslint/adjacent-overload-signatures": ["error"],
    "@typescript-eslint/ban-ts-comment": ["error"],
    "@typescript-eslint/no-empty-object-type": ["error"],
    "@typescript-eslint/no-unsafe-function-type": ["error"],
    "@typescript-eslint/no-wrapper-object-types": ["error"],
    "@typescript-eslint/explicit-module-boundary-types": ["warn"],
    "@typescript-eslint/no-array-constructor": ["error"],
    "@typescript-eslint/no-empty-function": [
      "error",
      {
        allow: ["arrowFunctions", "functions", "methods"],
      },
    ],
    "@typescript-eslint/no-explicit-any": ["warn"],
    "@typescript-eslint/no-extra-non-null-assertion": ["error"],
    "@typescript-eslint/no-inferrable-types": ["error"],
    "@typescript-eslint/no-misused-new": ["error"],
    "@typescript-eslint/no-namespace": ["error"],
    "@typescript-eslint/no-non-null-asserted-optional-chain": ["error"],
    "@typescript-eslint/no-non-null-assertion": ["warn"],
    "@typescript-eslint/no-this-alias": ["error"],
    "@typescript-eslint/no-unused-vars": [
      "warn",
      {
        vars: "all",
        args: "after-used",
        ignoreRestSiblings: true,
      },
    ],
    "@typescript-eslint/no-var-requires": ["error"],
    "@typescript-eslint/prefer-as-const": ["error"],
    "@typescript-eslint/prefer-namespace-keyword": ["error"],
    "@typescript-eslint/triple-slash-reference": ["error"],
    "@typescript-eslint/naming-convention": [
      "error",
      {
        selector: "variable",
        format: ["camelCase", "PascalCase", "UPPER_CASE"],
      },
      {
        selector: "function",
        format: ["camelCase", "PascalCase"],
      },
      {
        selector: "typeLike",
        format: ["PascalCase"],
      },
    ],
    "@typescript-eslint/dot-notation": [
      "error",
      {
        allowKeywords: true,
        allowPattern: "",
        allowPrivateClassPropertyAccess: false,
        allowProtectedClassPropertyAccess: false,
        allowIndexSignaturePropertyAccess: false,
      },
    ],
    "@typescript-eslint/no-dupe-class-members": ["error"],
    "@typescript-eslint/no-implied-eval": ["error"],
    "@typescript-eslint/no-loop-func": ["error"],
    "@typescript-eslint/no-redeclare": ["error"],
    "@typescript-eslint/no-shadow": ["error"],
    "@typescript-eslint/only-throw-error": ["error"],
    "@typescript-eslint/no-unused-expressions": [
      "error",
      {
        allowShortCircuit: false,
        allowTernary: false,
        allowTaggedTemplates: false,
      },
    ],
    "@typescript-eslint/no-useless-constructor": ["error"],
    "@typescript-eslint/return-await": ["error"],
    "@typescript-eslint/no-use-before-define": "off",
  },
  testRules: {
    "no-underscore-dangle": "off",
    "@typescript-eslint/naming-convention": "off",
    "@typescript-eslint/no-unused-expressions": "off",
    "@typescript-eslint/no-shadow": "off",
    "no-console": "off",
    "@typescript-eslint/no-unused-vars": "off",
  },
  deployPatchRules: {
    "func-names": "off",
    "no-restricted-syntax": "off",
    "no-await-in-loop": "off",
    "no-continue": "off",
    "global-require": "off",
    "no-console": "off",
  },
  jsRules: {
    // Core counterparts of the inherited TypeScript extension rules. JavaScript
    // is not compiler-checked, and must retain the same runtime correctness policy.
    "no-array-constructor": ["error"],
    "no-empty-function": [
      "error",
      { allow: ["arrowFunctions", "functions", "methods"] },
    ],
    "dot-notation": ["error", { allowKeywords: true, allowPattern: "" }],
    "no-dupe-class-members": ["error"],
    "no-implied-eval": ["error"],
    // Core no-implied-eval covers timers; Function needs its own rule.
    "no-new-func": ["error"],
    "no-loop-func": ["error"],
    "no-redeclare": ["error"],
    "no-shadow": ["error"],
    "no-throw-literal": ["error"],
    "no-unused-expressions": [
      "error",
      {
        allowShortCircuit: false,
        allowTernary: false,
        allowTaggedTemplates: false,
      },
    ],
    "no-useless-constructor": ["error"],
    "constructor-super": ["error"],
    "no-const-assign": ["error"],
    "no-new-native-nonconstructor": ["error"],
    "no-this-before-super": ["error"],
    "no-undef": ["error"],
    "getter-return": [
      "error",
      {
        allowImplicit: true,
      },
    ],
    "no-dupe-args": ["error"],
    "no-dupe-keys": ["error"],
    "no-func-assign": ["error"],
    "no-obj-calls": ["error"],
    "no-unreachable": ["error"],
    "no-unsafe-negation": ["error"],
    "valid-typeof": [
      "error",
      {
        requireStringLiterals: true,
      },
    ],
    "no-unused-vars": [
      "warn",
      { vars: "all", args: "after-used", ignoreRestSiblings: true },
    ],
  },
}
