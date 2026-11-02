# Reviewed inputs for npm releases

The SDK and contracts publishers build from their committed manifests and Yarn
locks. They do not resolve the registry's moving `development` tags during a
release. The direct upstream contract dependencies are exact versions so the
published package also refers to the artifact versions used by its build.

Both packages use Yarn 4.12.0 and the workflows run `yarn install --immutable`.
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
without `NPM_TOKEN`. The contracts job explicitly runs its existing
`prepublishOnly` and `prepack` hooks before creating a tarball. The SDK has no
pack hooks. Both jobs pack with lifecycle scripts disabled, then give the token
only to `npm publish <tarball> --ignore-scripts`. Packing also uses
`--script-shell=/usr/bin/false`: npm 10 can still invoke `prepare` despite
`--ignore-scripts`, so an unexpected hook fails closed without executing it.

Keep future package preparation hooks in the token-free preparation step. Do not
restore dependency updates, source builds or lifecycle scripts to the credentialed
publish step. The workflows use read-only GitHub permissions and do not persist
checkout credentials.

Run `node --test .github/tests/npm-publication.test.cjs` to check the preparation
and publication commands against local package fixtures without publishing.
The tests also flag new lifecycle hooks that need an explicit preparation step.

This separates package preparation from the publisher's npm token within the
job; it is not a sandbox against malicious code persisting in that job. Further
runner/process isolation is a separate control.
