import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type {
  CompleteP2TRHandshakeRegistryStub,
  CompleteP2TRHandshakeRouterStub,
  P2TRFraudEvidenceHandshakeHarness,
} from "../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("P2TRFraudEvidenceProtocol - handshake vs. accounting", () => {
  let bridgeAddress: string
  let frostRegistryAddress: string
  let registry: CompleteP2TRHandshakeRegistryStub
  let router: CompleteP2TRHandshakeRouterStub
  let harness: P2TRFraudEvidenceHandshakeHarness

  before(async () => {
    const signers: SignerWithAddress[] = await ethers.getSigners()
    bridgeAddress = signers[1].address
    frostRegistryAddress = signers[2].address

    registry = (await (
      await ethers.getContractFactory("CompleteP2TRHandshakeRegistryStub")
    ).deploy(
      bridgeAddress,
      frostRegistryAddress
    )) as CompleteP2TRHandshakeRegistryStub

    router = (await (
      await ethers.getContractFactory("CompleteP2TRHandshakeRouterStub")
    ).deploy(
      bridgeAddress,
      registry.address
    )) as CompleteP2TRHandshakeRouterStub

    harness = (await (
      await ethers.getContractFactory("P2TRFraudEvidenceHandshakeHarness")
    ).deploy()) as P2TRFraudEvidenceHandshakeHarness
  })

  beforeEach(createSnapshot)
  afterEach(restoreSnapshot)

  describe("with pristine accounting", () => {
    it("accepts the router on both the wiring and the install gate", async () => {
      expect(
        await harness.checkWiring(
          router.address,
          bridgeAddress,
          frostRegistryAddress
        )
      ).to.equal(registry.address)
      await harness.checkInstall(
        router.address,
        bridgeAddress,
        frostRegistryAddress
      )
    })
  })

  describe("after the first pre-signing ceremony", () => {
    beforeEach(async () => {
      await registry.recordPreSigningCeremony()
    })

    // This is the regression. `authorizedChallengeIdentityCount` and
    // `activeReservationSetVersion` are strictly monotonic in the production
    // registry, so if wallet creation asserted them to be zero it would revert
    // forever after the very first pre-signing ceremony.
    it("still accepts the router on the wiring gate", async () => {
      expect((await registry.authorizedChallengeIdentityCount()).gt(0)).to.be
        .true
      expect((await registry.activeReservationSetVersion()).gt(0)).to.be.true

      expect(
        await harness.checkWiring(
          router.address,
          bridgeAddress,
          frostRegistryAddress
        )
      ).to.equal(registry.address)
    })

    it("rejects the router on the install gate", async () => {
      await expect(
        harness.checkInstall(
          router.address,
          bridgeAddress,
          frostRegistryAddress
        )
      ).to.be.revertedWith("P2TRFraudEvidenceUnavailable")
    })

    it("never returns to a pristine state", async () => {
      const versionBefore = await registry.activeReservationSetVersion()
      await registry.recordPreSigningCeremony()
      expect((await registry.activeReservationSetVersion()).gt(versionBefore))
        .to.be.true
    })
  })

  describe("during ordinary operation", () => {
    // Each of these is a normal, transient state - a wallet mid-signing, an
    // open challenge, escrow held, or a resolved challenge whose payout has
    // not been withdrawn yet. None of them may block wallet creation.
    const states: {
      name: string
      apply: () => Promise<unknown>
    }[] = [
      {
        name: "a wallet is mid-signing",
        apply: () => registry.setActiveReservationCount(1),
      },
      {
        name: "a fraud challenge is open",
        apply: () => router.setOpenFraudChallengeCount(1),
      },
      {
        name: "challenge escrow is held",
        apply: () => router.setTotalChallengeEscrow(1),
      },
      {
        name: "a resolved payout is not yet withdrawn",
        apply: () => router.setTotalWithdrawablePayouts(1),
      },
    ]

    states.forEach(({ name, apply }) => {
      it(`accepts the router on the wiring gate while ${name}`, async () => {
        await apply()
        expect(
          await harness.checkWiring(
            router.address,
            bridgeAddress,
            frostRegistryAddress
          )
        ).to.equal(registry.address)
      })

      it(`rejects the router on the install gate while ${name}`, async () => {
        await apply()
        await expect(
          harness.checkInstall(
            router.address,
            bridgeAddress,
            frostRegistryAddress
          )
        ).to.be.revertedWith("P2TRFraudEvidenceUnavailable")
      })
    })
  })

  describe("wiring failures", () => {
    it("rejects a router bound to another Bridge on both gates", async () => {
      await expect(
        harness.checkWiring(
          router.address,
          frostRegistryAddress,
          frostRegistryAddress
        )
      ).to.be.revertedWith("P2TRFraudEvidenceUnavailable")
      await expect(
        harness.checkInstall(
          router.address,
          frostRegistryAddress,
          frostRegistryAddress
        )
      ).to.be.revertedWith("P2TRFraudEvidenceUnavailable")
    })

    it("rejects a registry bound to another FROST registry on both gates", async () => {
      await expect(
        harness.checkWiring(router.address, bridgeAddress, bridgeAddress)
      ).to.be.revertedWith("P2TRFraudEvidenceUnavailable")
      await expect(
        harness.checkInstall(router.address, bridgeAddress, bridgeAddress)
      ).to.be.revertedWith("P2TRFraudEvidenceUnavailable")
    })

    it("rejects the zero router on both gates", async () => {
      await expect(
        harness.checkWiring(
          ethers.constants.AddressZero,
          bridgeAddress,
          frostRegistryAddress
        )
      ).to.be.revertedWith("P2TRFraudEvidenceUnavailable")
      await expect(
        harness.checkInstall(
          ethers.constants.AddressZero,
          bridgeAddress,
          frostRegistryAddress
        )
      ).to.be.revertedWith("P2TRFraudEvidenceUnavailable")
    })
  })
})
