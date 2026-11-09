# Integrator contract fork

`AbstractBTCDepositor.sol`, `IBridge.sol`, and `ITBTCVault.sol` are a local
fork of the canonical `solidity/contracts/integrator/` sources. `FORK.json`
records the sha256 of each canonical file this fork last tracked and the list
of deliberate divergences.

Unlike `contracts/vendor/random-beacon`, this fork is **not** verbatim: the
StarkNet rail cannot pull in the `bitcoin-spv-sol` dependency tree, so
`AbstractBTCDepositor._calculateBitcoinTxHash` reimplements the double
SHA-256 Bitcoin transaction hash inline instead of calling
`BTCUtils.hash256View`. This is the first deliberate logic divergence
between the two trees, introduced by PR #1150. The two implementations are
functionally equivalent (same digest, same byte order); only the compiled
bytecode differs.

Future edits to any of these three files must be deliberate: either mirror
the change in `solidity/contracts/integrator/` (when both trees should stay
in lockstep) or record the divergence in `FORK.json`'s `changes` array (when
this rail intentionally diverges). Do not silently drift from the canonical
source.
