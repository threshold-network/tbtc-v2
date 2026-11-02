# Reviewed inputs for npm releases

The SDK and contracts publishers build from their committed manifests and Yarn
locks. They do not resolve the registry's moving `development` tags during a
release. The direct upstream contract dependencies are exact versions so the
published package also refers to the artifact versions used by its build.

Both packages use Yarn 4.12.0 with Node 22.23.4 in the publishing workflows,
which run `yarn install --immutable`.
If a manifest and lock disagree, publication stops rather than repairing the
inputs in the publishing job.

## Updating upstream contracts

After an upstream contract package is published:

1. Confirm the intended upstream release and its provenance. Select its exact
   version rather than passing a dist-tag to the publishing workflow.
2. In `solidity/` or `typescript/`, run `yarn add --exact <package>@<version>`
   with the pinned package manager. Commit both `package.json` and `yarn.lock`
   in a reviewable change. The existing exact versions initially preserve the
   versions already recorded in the locks; this policy does not upgrade them.
3. Run the affected package's build and tests. For contracts, also run
   `yarn deploy:test --network hardhat --write true` and check the generated
   deployment artifacts. For the SDK, verify type generation against the
   selected contract artifacts.
4. Merge the input update before invoking publication. Publishing a new
   contracts package does not automatically change the SDK's selected version;
   update and review the SDK pin separately when it should consume that release.

The `development` tag on the _output_ npm publication remains unchanged. It is a
distribution channel, not a build input.

## Preparation and publication

Builds, local Hardhat deployment, version bumping and artifact preparation run
in the `prepare` job without `NPM_TOKEN`. The contracts job explicitly runs its
existing `prepublishOnly` and `prepack` hooks before creating a tarball. The SDK
has no pack hooks. Packing uses `--ignore-scripts --script-shell=/usr/bin/false`:
npm 10 can still invoke `prepare` despite `--ignore-scripts`, so an unexpected
hook fails closed without executing it.

The preparation job stages exactly one regular tarball as `package.tgz`, records
its SHA-256 digest, and uploads only that file with the pinned official artifact
action. Its artifact name includes the workflow run ID and attempt. The publish
job depends on this job's successful completion and downloads the exact artifact
ID returned by the upload. It supplies no cross-run/repository token or run ID,
so the download action searches only the current workflow run. Uploads do not
overwrite existing artifacts.

Publication runs on a separate GitHub-hosted runner. It has no checkout,
dependency installation, build, or cache restore. Its working directory remains
empty; the downloaded tarball is stored under `runner.temp`. Before introducing
the npm token, it rejects missing or malformed artifact IDs/digests, additional
files, symlinks, and a tarball whose SHA-256 differs from the preparation output.
This explicit checksum check fails closed even though the download action's
built-in artifact digest mismatch handling only emits a warning.

Before receiving the token, the publisher also reads package metadata with the
`pacote` parser bundled with its pinned npm toolchain. It uses offline mode,
disabled scripts, and a fresh inspection cache under `runner.temp`. It rejects
any `publishConfig` field so package metadata cannot override publisher network
or authentication settings. This parser may unpack files into that isolated
inspection cache; no package code is run and the cache is not shared or restored.

Only the final `npm publish <tarball>` step receives `NPM_TOKEN`. It uses the npm
registry explicitly and disables lifecycle scripts and their script shell. Build
processes and changes to the build runner's filesystem do not carry over to the
publishing runner. This protects the publication credential from build-time
code; it does not establish that the contents of the built package are safe.

Keep future package preparation hooks in the preparation job. Do not add source
checkouts, build caches, dependency updates, or lifecycle scripts to the publish
job. Both jobs use read-only GitHub permissions and the
preparation checkout does not persist credentials.

Run `node --test .github/tests/npm-publication.test.cjs` to check preparation,
transfer validation, and publication against local package fixtures without
publishing. The tests use separate build and publisher directories, exercise
malformed identities, changed/additional files, forbidden lifecycle hooks, and
package-controlled npm configuration,
and guard the publish job's action and command allowlist. They also flag new
package lifecycle hooks that need explicit preparation.
