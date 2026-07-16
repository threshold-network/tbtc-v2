/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-expressions */

import { expect } from "chai"
import { ethers } from "hardhat"
import fs from "fs"
import func from "../../deploy/87_deploy_covenant_spend_authorization"

const { utils } = ethers

const DEPLOYER = "0x1111111111111111111111111111111111111111"
const REGISTRY = "0x2222222222222222222222222222222222222222"
const REQUESTED_OWNER = "0x68ad60CC5e8f3B7cC53beaB321cf0e6036962dBc"
// Arbitrary runtime bytes; the script hashes both the on-chain code and the
// artifact `deployedBytecode`, so the mock returns the SAME bytes for both.
const RUNTIME = "0x60016001016000526001601ff3"

async function expectReject(
  promise: Promise<unknown>,
  substring?: string
): Promise<void> {
  try {
    await promise
    expect.fail("expected the promise to reject")
  } catch (error) {
    if (substring) {
      expect((error as Error).message).to.include(substring)
    }
  }
}

interface MockOptions {
  chainId?: string
  ownerReturn?: string // what registry.owner() returns before transfer
  runtimeCode?: string // what provider.getCode returns
  artifactRuntime?: string // artifact.deployedBytecode
  isAuthorized?: boolean
}

function createMockHre(options: MockOptions = {}): {
  mockHre: any
  deployCalls: any[]
  transferCalls: string[]
} {
  const deployCalls: any[] = []
  const transferCalls: string[] = []
  let currentOwner = options.ownerReturn ?? DEPLOYER

  const registryStub: any = {
    owner: async () => currentOwner,
    isAuthorized: async () => options.isAuthorized ?? false,
    connect: () => ({
      transferOwnership: async (newOwner: string) => {
        transferCalls.push(utils.getAddress(newOwner))
        currentOwner = utils.getAddress(newOwner)
        return { wait: async () => undefined }
      },
    }),
  }

  const mockHre: any = {
    ethers: {
      ...ethers,
      provider: {
        getCode: async () => options.runtimeCode ?? RUNTIME,
      },
      getContractAt: async () => registryStub,
      getSigner: async () => ({ address: DEPLOYER }),
      constants: ethers.constants,
      utils: ethers.utils,
    },
    deployments: {
      deploy: async (name: string, opts: any) => {
        deployCalls.push({ name, options: opts })
        return { address: REGISTRY, newlyDeployed: true }
      },
      getArtifact: async () => ({
        deployedBytecode: options.artifactRuntime ?? RUNTIME,
      }),
    },
    getNamedAccounts: async () => ({ deployer: DEPLOYER }),
    getChainId: async () => options.chainId ?? "11155111",
    network: { name: "sepolia", tags: {} },
  }
  return { mockHre, deployCalls, transferCalls }
}

describe("87_deploy_covenant_spend_authorization", () => {
  const ENV_KEYS = [
    "DEPLOY_STAGE3_COVENANT_AUTHORIZATION",
    "COVENANT_SPEND_AUTHORIZATION_OWNER",
    "ETHERSCAN_API_KEY",
  ]
  let savedEnv: Record<string, string | undefined>
  let originalMkdirSync: typeof fs.mkdirSync
  let originalWriteFileSync: typeof fs.writeFileSync
  let originalConsoleLog: typeof console.log

  beforeEach(() => {
    savedEnv = {}
    ENV_KEYS.forEach((k) => {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    })
    // Set the required owner for the success-path tests; individual tests
    // override or delete it as needed.
    process.env.COVENANT_SPEND_AUTHORIZATION_OWNER = REQUESTED_OWNER

    originalMkdirSync = fs.mkdirSync
    originalWriteFileSync = fs.writeFileSync
    originalConsoleLog = console.log
    const mutableFs = fs as any
    mutableFs.mkdirSync = () => undefined
    mutableFs.writeFileSync = () => undefined
    console.log = () => undefined
  })

  afterEach(() => {
    ENV_KEYS.forEach((k) => {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    })
    ;(fs as any).mkdirSync = originalMkdirSync
    ;(fs as any).writeFileSync = originalWriteFileSync
    console.log = originalConsoleLog
  })

  it("is tagged for the Stage-3 covenant deployment", () => {
    expect(func.tags).to.include("DeployCovenantSpendAuthorizationStage3")
  })

  it("skips unless DEPLOY_STAGE3_COVENANT_AUTHORIZATION is true", async () => {
    expect(await func.skip!({} as any)).to.equal(true)
    process.env.DEPLOY_STAGE3_COVENANT_AUTHORIZATION = "false"
    expect(await func.skip!({} as any)).to.equal(true)
    process.env.DEPLOY_STAGE3_COVENANT_AUTHORIZATION = "true"
    expect(await func.skip!({} as any)).to.equal(false)
  })

  it("refuses any chain other than Sepolia", async () => {
    const { mockHre, deployCalls } = createMockHre({ chainId: "1" })
    await expectReject(func(mockHre), "is not Sepolia")
    expect(deployCalls.length).to.equal(0)
  })

  it("requires COVENANT_SPEND_AUTHORIZATION_OWNER", async () => {
    delete process.env.COVENANT_SPEND_AUTHORIZATION_OWNER
    const { mockHre, deployCalls } = createMockHre()
    await expectReject(
      func(mockHre),
      "COVENANT_SPEND_AUTHORIZATION_OWNER must be set"
    )
    expect(deployCalls.length).to.equal(0)
  })

  it("rejects a zero requested owner", async () => {
    process.env.COVENANT_SPEND_AUTHORIZATION_OWNER =
      ethers.constants.AddressZero
    const { mockHre, deployCalls } = createMockHre()
    await expectReject(func(mockHre), "must not be the zero address")
    expect(deployCalls.length).to.equal(0)
  })

  it("deploys the registry with no args under the correct fully-qualified name", async () => {
    const { mockHre, deployCalls } = createMockHre()
    await func(mockHre)
    const call = deployCalls.find(
      (c) => c.name === "CovenantSpendAuthorization"
    )
    expect(call, "CovenantSpendAuthorization deploy call").to.not.be.undefined
    expect(call.options.contract).to.equal(
      "contracts/bridge/CovenantSpendAuthorization.sol:CovenantSpendAuthorization"
    )
    expect(call.options.args).to.deep.equal([])
    expect(call.options.from).to.equal(DEPLOYER)
    expect(call.options.waitConfirmations).to.equal(1)
  })

  it("transfers ownership from the deployer to the requested owner", async () => {
    const { mockHre, transferCalls } = createMockHre({ ownerReturn: DEPLOYER })
    await func(mockHre)
    expect(transferCalls).to.deep.equal([utils.getAddress(REQUESTED_OWNER)])
  })

  it("does not transfer when the registry already has the requested owner", async () => {
    const { mockHre, transferCalls } = createMockHre({
      ownerReturn: REQUESTED_OWNER,
    })
    await func(mockHre)
    expect(transferCalls.length).to.equal(0)
  })

  it("aborts when the owner is neither the deployer nor the requested owner", async () => {
    const { mockHre } = createMockHre({
      ownerReturn: "0x9999999999999999999999999999999999999999",
    })
    await expectReject(func(mockHre), "aborting rather than reassigning")
  })

  it("aborts when the deployed runtime hash does not match the artifact", async () => {
    const { mockHre } = createMockHre({
      runtimeCode: "0xdeadbeef",
      artifactRuntime: RUNTIME,
    })
    await expectReject(func(mockHre), "does not match the compiled artifact")
  })

  it("aborts when a freshly deployed registry reports isAuthorized true", async () => {
    const { mockHre } = createMockHre({ isAuthorized: true })
    await expectReject(func(mockHre), "expected a clean, empty registry")
  })

  it("aborts when the deployed registry has no runtime code", async () => {
    const { mockHre } = createMockHre({ runtimeCode: "0x" })
    await expectReject(func(mockHre), "has no runtime code")
  })
})
