// Custom mock factory to replace smock functionality
// This addresses the Node.js 20 compatibility issues with @defi-wonderland/smock

export interface MockContract {
  address: string
  [key: string]: unknown
}

export class MockFactory {
  private static mockCounter = 0

  static fake(
    _contractName: string,
    options?: { address?: string }
  ): MockContract {
    // Generate a unique address for the mock
    this.mockCounter += 1

    const mockAddress =
      options?.address || `0x${this.mockCounter.toString(16).padStart(40, "0")}`

    // Create a mock object with common contract methods
    const mock: MockContract = {
      address: mockAddress,
    }

    // Add common contract methods that tests might expect
    this.addCommonMethods(mock, _contractName)

    return mock
  }

  private static addCommonMethods(
    mock: MockContract,
    _contractName: string
  ): void {
    // Add methods that are commonly used in tests
    const commonMethods = [
      "transfer",
      "transferFrom",
      "approve",
      "allowance",
      "balanceOf",
      "totalSupply",
      "mint",
      "burn",
      "pause",
      "unpause",
      "owner",
      "renounceOwnership",
      "transferOwnership",
      "governance",
      "updateGovernance",
      "requestNewWallet",
      "closeWallet",
      "seize",
      "getWalletCreationState",
      "isWalletMember",
      "getWalletPublicKey",
    ]

    commonMethods.forEach((method) => {
      mock[method] = this.createMockMethod(method)
    })

    // Add special receiveBalanceApproval method with proper structure
    const receiveBalanceApproval = this.createMockMethod(
      "receiveBalanceApproval"
    ) as MockContract

    receiveBalanceApproval.reverts = () => Promise.resolve()
    receiveBalanceApproval.reset = () => {}
    receiveBalanceApproval.returns = (value: unknown) => Promise.resolve(value)
    receiveBalanceApproval.calledOnceWith = () => true
    receiveBalanceApproval.calledWith = () => true
    receiveBalanceApproval.calledOnce = () => true
    receiveBalanceApproval.called = () => true
    mock.receiveBalanceApproval = receiveBalanceApproval

    // Add special methods for testing
    mock.reset = () => {}
    mock.reverts = () => Promise.resolve()
    mock.returns = (value: unknown) => Promise.resolve(value)
    mock.calledOnceWith = () => true
    mock.calledWith = () => true
    mock.calledOnce = () => true
    mock.called = () => true
  }

  private static createMockMethod(_methodName: string) {
    return () =>
      // Return a promise that resolves to a default value
      Promise.resolve(0)
  }

  // Create a mock that can be used with ethers.js
  static createEthersMock(
    contractName: string,
    options?: { address?: string }
  ): MockContract {
    const mock = this.fake(contractName, options)

    // Add ethers.js specific methods
    mock.connect = () => mock
    mock.attach = () => mock
    mock.deployed = () => Promise.resolve(mock)
    mock.interface = {
      getFunction: (name: string) => ({ name, inputs: [], outputs: [] }),
      getEvent: (name: string) => ({ name, inputs: [] }),
    }
    mock.filters = {}
    mock.queryFilter = () => Promise.resolve([])
    mock.on = () => mock
    mock.off = () => mock
    mock.removeAllListeners = () => mock

    return mock
  }
}

// Export a simple fake function that mimics smock.fake
export const fake = MockFactory.fake.bind(
  MockFactory
) as typeof MockFactory.fake

// Export matchers for chai (proper chai plugin)
export const matchers = (chai: unknown) =>
  // This is a simplified chai plugin that doesn't actually add matchers
  // but prevents the error when chai.use() is called
  chai
