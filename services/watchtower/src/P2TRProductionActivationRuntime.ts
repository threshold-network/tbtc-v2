import { resolve } from "node:path"
import type {
  P2TRProductionBitcoinCandidateIdentity,
  P2TRProductionBitcoinEvidenceProvider,
  P2TRProductionCandidateEnqueuer,
  P2TRProductionEthereumProvider,
  P2TRProductionFrostHandshakeState,
  P2TRProductionOutboxHandshakeState,
  P2TRProductionSignedHandshakeProvider,
  P2TRProductionActivationExpectedProtocols,
  P2TRProductionReadySnapshot,
} from "./P2TRProductionActivation.js"
import { P2TRProductionActivationGate } from "./P2TRProductionActivation.js"
import {
  loadP2TRWatchtowerMigrations,
  runP2TRWatchtowerMigrations,
  type P2TRWatchtowerMigrationPool,
  type P2TRWatchtowerMigrationRunnerOptions,
} from "./P2TRWatchtowerMigrations.js"
import {
  PostgresP2TRCanonicalIndexStore,
  type P2TRPostgresPool,
  type P2TRPostgresTransactionSession,
  type PostgresP2TRCanonicalIndexStoreOptions,
} from "./PostgresP2TRCanonicalIndexStore.js"
import {
  PostgresP2TRProductionActivationStore,
  PostgresP2TRProductionComponentHealthRecorder,
  type PostgresP2TRProductionActivationStoreOptions,
} from "./PostgresP2TRProductionActivationStore.js"

export type P2TRProductionActivationRuntimeDependencies = {
  ethereumSource: P2TRProductionEthereumProvider
  ethereumVerifier: P2TRProductionEthereumProvider
  bitcoinIndexSource: P2TRProductionBitcoinEvidenceProvider
  bitcoinReconciler: P2TRProductionBitcoinEvidenceProvider
  outboxHandshake: P2TRProductionSignedHandshakeProvider<P2TRProductionOutboxHandshakeState>
  frostSignerHandshake: P2TRProductionSignedHandshakeProvider<P2TRProductionFrostHandshakeState>
  createCandidateEnqueuer(
    session: P2TRPostgresTransactionSession,
    storeID: string
  ): P2TRProductionCandidateEnqueuer
}

export type P2TRProductionActivationRuntimeOptions = {
  migrationsDirectory: string
  trustedManifestSignerKeyHash: string
  expectedProtocols: P2TRProductionActivationExpectedProtocols
  migrationRunner?: P2TRWatchtowerMigrationRunnerOptions
  coordinator: PostgresP2TRCanonicalIndexStoreOptions
  activationStore: Omit<PostgresP2TRProductionActivationStoreOptions, "storeID">
  candidateAuthorizationLifetimeMs?: number
}

/** Fully composed production authority; construction includes migrations,
 * exact manifest readback, dependency ownership checks, and live readiness. */
export type P2TRProductionActivationRuntime = {
  readonly coordinator: PostgresP2TRCanonicalIndexStore
  readonly gate: P2TRProductionActivationGate
  readonly componentHealth: PostgresP2TRProductionComponentHealthRecorder
  assertReady(): Promise<P2TRProductionReadySnapshot>
  enqueueReconciledCandidate(
    candidate: P2TRProductionBitcoinCandidateIdentity
  ): Promise<string>
}

export async function createPostgresP2TRProductionActivationRuntime(
  pool: P2TRPostgresPool & P2TRWatchtowerMigrationPool,
  dependencies: P2TRProductionActivationRuntimeDependencies,
  options: P2TRProductionActivationRuntimeOptions
): Promise<P2TRProductionActivationRuntime> {
  const migrations = await loadP2TRWatchtowerMigrations(
    resolve(options.migrationsDirectory)
  )
  await runP2TRWatchtowerMigrations(pool, migrations, options.migrationRunner)

  const coordinator = new PostgresP2TRCanonicalIndexStore(
    pool,
    options.coordinator
  )
  const stateStore =
    coordinator.createP2TRSignatureFraudWatchtowerTransactionalAdapter(
      (session) =>
        new PostgresP2TRProductionActivationStore(session, {
          ...options.activationStore,
          storeID: coordinator.p2trSignatureFraudWatchtowerTransactionalStoreID,
          maxCandidateAuthorizationLifetimeMs:
            options.candidateAuthorizationLifetimeMs ??
            options.activationStore.maxCandidateAuthorizationLifetimeMs,
        })
    )
  const componentHealth =
    coordinator.createP2TRSignatureFraudWatchtowerTransactionalAdapter(
      (session) =>
        new PostgresP2TRProductionComponentHealthRecorder(
          session,
          coordinator.p2trSignatureFraudWatchtowerTransactionalStoreID
        )
    )
  const candidateEnqueuer =
    coordinator.createP2TRSignatureFraudWatchtowerTransactionalAdapter(
      (session) =>
        dependencies.createCandidateEnqueuer(
          session,
          coordinator.p2trSignatureFraudWatchtowerTransactionalStoreID
        )
    )
  const envelope =
    await coordinator.runInP2TRSignatureFraudWatchtowerTransaction(() =>
      stateStore.loadActivationEnvelope(options.trustedManifestSignerKeyHash)
    )
  const gate = new P2TRProductionActivationGate(
    envelope,
    {
      ethereumSource: dependencies.ethereumSource,
      ethereumVerifier: dependencies.ethereumVerifier,
      bitcoinIndexSource: dependencies.bitcoinIndexSource,
      bitcoinReconciler: dependencies.bitcoinReconciler,
      migrations: stateStore,
      stateStore,
      outboxHandshake: dependencies.outboxHandshake,
      frostSignerHandshake: dependencies.frostSignerHandshake,
      candidateEnqueuer,
      transactionCoordinator: coordinator,
    },
    {
      trustedManifestSignerKeyHash: options.trustedManifestSignerKeyHash,
      expectedProtocols: options.expectedProtocols,
      candidateAuthorizationLifetimeMs:
        options.candidateAuthorizationLifetimeMs,
    }
  )
  // Startup is not considered successful until every live, signed, pinned
  // dependency and every durable health/readback invariant passes.
  await gate.assertReady()

  return Object.freeze({
    coordinator,
    gate,
    componentHealth,
    assertReady: () => gate.assertReady(),
    enqueueReconciledCandidate: async (
      candidate: P2TRProductionBitcoinCandidateIdentity
    ) => {
      const authorization = await gate.assertCandidateReconciled(candidate)
      return gate.consumeCandidateAuthorization(authorization, candidate)
    },
  })
}
