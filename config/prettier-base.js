// Shared base extracted from the vendored prettier-config-keep content that
// was previously duplicated verbatim across the root, cross-chain/bob,
// monitoring, and typescript. Consumers require() this by relative path and
// layer their own `plugins`/`overrides` on top where needed.
module.exports = {
  semi: false,
}
