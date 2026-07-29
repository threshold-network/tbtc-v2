export const PINNED_EVIDENCE_REF_BODY =
  "(ipfs://\\S+|sha256:[0-9a-fA-F]{64}|git:[0-9a-fA-F]{40}|https://github\\.com/\\S+@[0-9a-fA-F]{40}#\\S+)"
export const PINNED_EVIDENCE_REF_PATTERN = new RegExp(
  `^(${PINNED_EVIDENCE_REF_BODY}|` +
    `(signature|signatureRef|sig):${PINNED_EVIDENCE_REF_BODY}|` +
    `(provenance|provenanceRef|attestation|slsa):${PINNED_EVIDENCE_REF_BODY})$`,
  "i"
)
export const EVIDENCE_MANIFEST_SCHEMA_VERSION =
  "frost-readiness-evidence-manifest-v0"

export const collapseWhitespace = (value) => value.replace(/\s+/g, " ").trim()

export const textIncludes = (text, snippet) =>
  text.includes(snippet) ||
  collapseWhitespace(text).includes(collapseWhitespace(snippet))

export const createRequireTextIncludes =
  (fail) => (text, requiredSnippets, label) => {
    for (const snippet of requiredSnippets) {
      if (!textIncludes(text, snippet)) {
        fail(`${label} must include ${snippet}`)
      }
    }
  }

export const requireEvidenceManifestSchema = (manifest, label, fail) => {
  if (manifest.schemaVersion !== EVIDENCE_MANIFEST_SCHEMA_VERSION) {
    fail(`${label} schemaVersion must be ${EVIDENCE_MANIFEST_SCHEMA_VERSION}`)
  }
}

export const requireStructuredOwner = (owner, label, fail) => {
  if (owner === null || typeof owner !== "object" || Array.isArray(owner)) {
    fail(`${label} requires structured owner {name, role, githubHandle}`)
  }

  for (const field of ["name", "role", "githubHandle"]) {
    if (typeof owner[field] !== "string" || owner[field].length === 0) {
      fail(`${label}.owner.${field} must be a non-empty string`)
    }
  }

  if (!/^@?[A-Za-z0-9-]{1,39}$/.test(owner.githubHandle)) {
    fail(`${label}.owner.githubHandle must be a GitHub handle`)
  }
}

// Strip line comments (// to end-of-line) and block comments (slash-star to
// star-slash) from a source text. The stripping is intentionally naive (it
// does not parse string literals or handle escape sequences) because the gate
// use case only needs to defend against the simplest hostile rewrite: moving a
// require/revert into a comment while leaving the literal message visible to
// `textIncludes`. Solidity, JavaScript/TypeScript, and Rust all share this
// comment syntax.
export const stripCommentsForGate = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

// Assert that `message` appears in `text` outside of line and block comments.
// Defends gates that pin revert/require strings from a hostile diff that
// removes the enforcement but leaves the literal text in a comment that a
// plain `textIncludes` check would still satisfy.
export const requireRevertString = (text, message, label, fail) => {
  if (!stripCommentsForGate(text).includes(message)) {
    fail(
      `${label} must include revert string ${JSON.stringify(
        message
      )} outside of comments`
    )
  }
}

export const requirePinnedEvidenceRefs = (refs, label, fail) => {
  if (!Array.isArray(refs) || refs.length === 0) {
    fail(`${label} requires pinned evidence refs`)
  }

  for (const ref of refs) {
    if (typeof ref !== "string" || !PINNED_EVIDENCE_REF_PATTERN.test(ref)) {
      fail(
        `${label} must contain pinned refs: ipfs://, sha256:<64-hex>, ` +
          "git:<40-hex>, https://github.com/...@<40-hex>#..., or " +
          "signature:/provenance:-prefixed pinned refs"
      )
    }
  }
}
