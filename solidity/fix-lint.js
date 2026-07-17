import fs from "fs"
import path from "path"
import * as glob from "glob"

// Fix unnamed async functions in deploy files
const deployFiles = glob.sync("deploy/*.ts")
deployFiles.forEach((file) => {
  let content = fs.readFileSync(file, "utf8")
  const funcName = path
    .basename(file, ".ts")
    .replace(/^\d+_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (l) => l.toUpperCase())
    .replace(/\s/g, "")
  content = content.replace(
    /const func: DeployFunction = async function \(/,
    `const func: DeployFunction = async function ${funcName}(`
  )
  fs.writeFileSync(file, content)
})

// Fix console.log statements
const testFiles = glob.sync("test/**/*.ts")
testFiles.forEach((file) => {
  let content = fs.readFileSync(file, "utf8")
  // Comment out console.log statements
  content = content.replace(/^(\s*)console\.log/gm, "$1// console.log")
  fs.writeFileSync(file, content)
})

console.log(
  "Basic lint fixes applied. Run npm run lint to see remaining issues."
)
