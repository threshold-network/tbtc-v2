import sinon from "sinon"
import * as crossChainPause from "../../src/lib/utils/cross-chain-pause"

/**
 * Keep testing the retained transaction algorithms behind the pause guard.
 * Only existing cross-chain implementation suites use this stub; the pause
 * regression suite exercises the real, unconditional pause instead.
 * @returns {void}
 */
export function exercisePausedCrossChainImplementation(): void {
  let guard: sinon.SinonStub

  beforeEach(() => {
    guard = sinon
      .stub(crossChainPause, "assertCrossChainOperationsAllowed")
      .returns(undefined)
  })

  afterEach(() => guard.restore())
}
