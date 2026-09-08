/**
 * Rewrites imports from the monolithic "ethers" package in the generated
 * `typechain/` bindings to the corresponding scoped `@ethersproject/*`
 * packages. This keeps the published `dist/` output (both the runtime
 * modules and the type declarations) free of references to "ethers", which
 * is only a devDependency of this package. Runs as part of the `typechain`
 * npm script, right after the bindings are generated.
 */
const fs = require("fs")
const path = require("path")

const SYMBOL_TO_PACKAGE = {
  Signer: "@ethersproject/abstract-signer",
  BigNumber: "@ethersproject/bignumber",
  BigNumberish: "@ethersproject/bignumber",
  BytesLike: "@ethersproject/bytes",
  BaseContract: "@ethersproject/contracts",
  CallOverrides: "@ethersproject/contracts",
  Contract: "@ethersproject/contracts",
  ContractFactory: "@ethersproject/contracts",
  ContractTransaction: "@ethersproject/contracts",
  Event: "@ethersproject/contracts",
  EventFilter: "@ethersproject/contracts",
  Overrides: "@ethersproject/contracts",
  PayableOverrides: "@ethersproject/contracts",
  PopulatedTransaction: "@ethersproject/contracts",
  Provider: "@ethersproject/abstract-provider",
}

const PROVIDERS_SYMBOL_TO_PACKAGE = {
  Listener: "@ethersproject/abstract-provider",
  Provider: "@ethersproject/abstract-provider",
  TransactionRequest: "@ethersproject/abstract-provider",
}

const ETHERS_IMPORT_REGEX =
  /import(\s+type)?\s*\{([^}]*)\}\s*from\s*['"]ethers['"];?/g

const PROVIDERS_IMPORT_REGEX =
  /import(\s+type)?\s*\{([^}]*)\}\s*from\s*['"]@ethersproject\/providers['"];?/g

// The generated code uses the `utils` namespace solely for `utils.Interface`
// which lives in the @ethersproject/abi package.
const UTILS_PACKAGE = "@ethersproject/abi"

/**
 * Rewrites "ethers" imports of a single generated file in place.
 * @param filePath Path of the file to rewrite.
 * @returns Nothing. The file is modified in place.
 */
function rewrite(filePath) {
  const source = fs.readFileSync(filePath, "utf8")

  const rewritten = source
    .replace(ETHERS_IMPORT_REGEX, (match, typeKeyword, symbolList) => {
      const type = typeKeyword ? "type " : ""
      const symbolsByPackage = new Map()
      let importsUtils = false

      for (const item of symbolList.split(",")) {
        const symbol = item.trim()
        if (!symbol) {
          continue
        }
        if (symbol === "utils") {
          importsUtils = true
          continue
        }
        const pkg = SYMBOL_TO_PACKAGE[symbol]
        if (!pkg) {
          throw new Error(
            `${filePath}: no @ethersproject mapping for "${symbol}" ` +
              `imported from "ethers"; update ${__filename}`
          )
        }
        if (!symbolsByPackage.has(pkg)) {
          symbolsByPackage.set(pkg, [])
        }
        symbolsByPackage.get(pkg).push(symbol)
      }

      const imports = [...symbolsByPackage.keys()]
        .sort()
        .map(
          (pkg) =>
            `import ${type}{ ${symbolsByPackage
              .get(pkg)
              .join(", ")} } from "${pkg}";`
        )

      if (importsUtils) {
        imports.push(`import ${type}* as utils from "${UTILS_PACKAGE}";`)
      }

      return imports.join("\n")
    })
    .replace(PROVIDERS_IMPORT_REGEX, (match, typeKeyword, symbolList) => {
      const type = typeKeyword ? "type " : ""
      const symbolsByPackage = new Map()

      for (const item of symbolList.split(",")) {
        const symbol = item.trim()
        if (!symbol) {
          continue
        }
        const pkg = PROVIDERS_SYMBOL_TO_PACKAGE[symbol]
        if (!pkg) {
          throw new Error(
            `${filePath}: no mapping for "${symbol}" ` +
              `imported from "@ethersproject/providers"; update ${__filename}`
          )
        }
        if (!symbolsByPackage.has(pkg)) {
          symbolsByPackage.set(pkg, [])
        }
        symbolsByPackage.get(pkg).push(symbol)
      }

      return [...symbolsByPackage.keys()]
        .sort()
        .map(
          (pkg) =>
            `import ${type}{ ${symbolsByPackage
              .get(pkg)
              .join(", ")} } from "${pkg}";`
        )
        .join("\n")
    })

  if (
    /(\bfrom\s*|require\(\s*|import\s*\(\s*|import\s+)['"](ethers|@ethersproject\/providers)(\/.*)?['"]/.test(
      rewritten
    ) ||
    /\/\/\/\s*<\s*reference[^>]*\b(ethers|@ethersproject\/providers)\b/.test(
      rewritten
    )
  ) {
    throw new Error(
      `${filePath}: unhandled import from "ethers" or "@ethersproject/providers" left after rewrite; ` +
        `update ${__filename}`
    )
  }

  if (rewritten !== source) {
    fs.writeFileSync(filePath, rewritten)
  }
}

/**
 * Recursively collects TypeScript files in a directory.
 * @param dir Directory to walk.
 * @returns Paths of all .ts files found.
 */
function walk(dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(fullPath))
    } else if (entry.name.endsWith(".ts")) {
      files.push(fullPath)
    }
  }
  return files
}

walk(path.join(__dirname, "..", "typechain")).forEach(rewrite)
