import { expect } from "chai"
import hre, { ethers, upgrades } from "hardhat"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import { Etherscan } from "@nomicfoundation/hardhat-verify/etherscan"
import { setMockDispatcher } from "@nomicfoundation/hardhat-verify/internal/undici"
import {
  callEtherscanApi,
  getEtherscanInstance,
} from "@openzeppelin/hardhat-upgrades/dist/utils/etherscan-api"
import ProxyAdmin from "@openzeppelin/upgrades-core/artifacts/@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol/ProxyAdmin.json"
import TransparentProxy from "@openzeppelin/upgrades-core/artifacts/@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy.json"
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici"
import transferProxyAdminOwnership from "../../deploy/26_transfer_proxy_admin_ownership"
import { loadFixture } from "../helpers/fixture"

const API_ORIGIN = "https://api.etherscan.io"
const API_KEY = "test key & value"
const configuredApiKeyType = typeof hre.config.etherscan.apiKey

async function proxyFixture() {
  const { deployer, esdm } = await hre.helpers.signers.getNamedSigners()
  const factory = await ethers.getContractFactory(
    "NativeBTCDepositor",
    deployer
  )
  // Initialization is unrelated to verification; these proxies exist only on
  // the local test chain and are never used as depositors.
  const options = { kind: "transparent" as const, initializer: false as const }
  const first = await upgrades.deployProxy(factory, [], options)
  const second = await upgrades.deployProxy(factory, [], options)
  await first.waitForDeployment()
  await second.waitForDeployment()
  await transferProxyAdminOwnership(hre)

  const proxy = await first.getAddress()
  const admin = await upgrades.erc1967.getAdminAddress(proxy)
  const implementation = await upgrades.erc1967.getImplementationAddress(proxy)
  const logs = await ethers.provider.getLogs({
    address: [proxy, admin],
    fromBlock: 0,
  })
  return { proxy, second, admin, implementation, logs, esdm }
}

describe("OpenZeppelin Etherscan V2 compatibility", () => {
  let mock: MockAgent
  let previousDispatcher: ReturnType<typeof getGlobalDispatcher>
  let previousConfig: typeof hre.config.etherscan

  beforeEach(() => {
    previousDispatcher = getGlobalDispatcher()
    previousConfig = hre.config.etherscan
    mock = new MockAgent()
    mock.disableNetConnect()
    setGlobalDispatcher(mock)
    setMockDispatcher(mock)
    hre.config.etherscan = {
      ...previousConfig,
      apiKey: API_KEY,
      customChains: [
        {
          network: "hardhat",
          chainId: 31337,
          urls: {
            apiURL: `${API_ORIGIN}/api`,
            browserURL: "https://etherscan.io",
          },
        },
      ],
    }
  })

  afterEach(async () => {
    hre.config.etherscan = previousConfig
    setMockDispatcher(undefined)
    setGlobalDispatcher(previousDispatcher)
    await mock.close()
  })

  it("configures one Etherscan V2 API key for the supported chains", () => {
    expect(configuredApiKeyType).to.equal("string")
  })
  ;[
    { name: "mainnet", chainId: 1 },
    { name: "sepolia", chainId: 11155111 },
  ].forEach(({ name, chainId }) => {
    it(`selects the V2 endpoint and chain ID for ${name}`, async () => {
      const instance = await getEtherscanInstance({
        config: { etherscan: { apiKey: API_KEY, customChains: [] } },
        network: {
          name,
          provider: {
            send: async (method: string) => {
              expect(method).to.equal("eth_chainId")
              return ethers.toQuantity(chainId)
            },
          },
        },
      } as unknown as HardhatRuntimeEnvironment)
      expect(instance.apiUrl).to.equal(`${API_ORIGIN}/v2/api`)
      expect(instance.chainId).to.equal(chainId)
    })
  })
  ;[
    { module: "logs", action: "getLogs", address: ethers.ZeroAddress },
    {
      module: "contract",
      action: "verifyproxycontract",
      address: ethers.ZeroAddress,
      expectedimplementation: ethers.ZeroAddress,
    },
    { module: "contract", action: "checkproxyverification", guid: "test-guid" },
  ].forEach((params) => {
    it(`sends ${params.action} with the API key and chain ID in the query`, async () => {
      const instance = new Etherscan(API_KEY, "", "", 11155111)
      const response = { status: "1", message: "OK", result: "test-result" }
      mock
        .get(API_ORIGIN)
        .intercept({
          method: "POST",
          path: "/v2/api",
          query: { ...params, apikey: API_KEY, chainid: "11155111" },
        })
        .reply(200, response)
      expect(await callEtherscanApi(instance, params)).to.deep.equal(response)
      mock.assertNoPendingInterceptors()
    })
  })

  it("preserves custom explorer URLs without inventing a chain ID", async () => {
    const instance = new Etherscan(
      API_KEY,
      "https://explorer.example/api",
      "",
      undefined
    )
    const params = {
      module: "contract",
      action: "checkproxyverification",
      guid: "custom-guid",
    }
    mock
      .get("https://explorer.example")
      .intercept({
        method: "POST",
        path: "/api",
        query: { ...params, apikey: API_KEY },
      })
      .reply(200, { status: "1", message: "OK", result: "verified" })
    expect((await callEtherscanApi(instance, params)).result).to.equal(
      "verified"
    )
    mock.assertNoPendingInterceptors()
  })

  it("propagates HTTP failures from the explorer", async () => {
    mock
      .get(API_ORIGIN)
      .intercept({ method: "POST", path: /^\/v2\/api/ })
      .reply(503, "Explorer unavailable")
    await expect(
      callEtherscanApi(new Etherscan(API_KEY, "", "", 1), {
        module: "logs",
        action: "getLogs",
      })
    ).to.be.rejectedWith(
      "Etherscan API call failed with status 503, response: Explorer unavailable"
    )
  })

  async function verifyProxy(rejectLink: boolean) {
    const { proxy, second, admin, implementation, logs, esdm } =
      await loadFixture(proxyFixture)
    expect(
      await upgrades.erc1967.getAdminAddress(await second.getAddress())
    ).to.equal(admin)
    expect(await (await upgrades.admin.getInstance()).getAddress()).to.equal(
      admin
    )
    expect(
      await (await ethers.getContractAt("ProxyAdmin", admin)).owner()
    ).to.equal(esdm.address)
    expect(await ethers.provider.getCode(admin)).to.equal(
      ProxyAdmin.deployedBytecode
    )
    expect(await ethers.provider.getCode(proxy)).to.equal(
      TransparentProxy.deployedBytecode
    )

    const submissions: string[] = []
    const discoveries: string[] = []
    let linkChecked = false
    mock
      .get(API_ORIGIN)
      .intercept({ method: /^(GET|POST)$/, path: /^\/v2\/api/ })
      .reply(
        (request: {
          path: string
          body?: unknown
          query?: Record<string, string | number>
        }) => {
          const url = new URL(request.path, API_ORIGIN)
          // Undici passes request({ query }) separately to mock reply callbacks.
          Object.entries(request.query || {}).forEach(([key, value]) => {
            url.searchParams.set(key, String(value))
          })
          expect(url.searchParams.get("chainid")).to.equal("31337")
          const params = new URLSearchParams(String(request.body || ""))
          url.searchParams.forEach((value, key) => params.set(key, value))
          expect(params.get("apikey")).to.equal(API_KEY)
          const action = params.get("action")
          let result: unknown
          switch (action) {
            case "getsourcecode":
              result = [{ SourceCode: "" }]
              break
            case "getLogs": {
              const address = params.get("address")
              discoveries.push(address.toLowerCase())
              result = logs.filter(
                (log) =>
                  log.address.toLowerCase() === address.toLowerCase() &&
                  log.topics[0] === params.get("topic0")
              )
              break
            }
            case "verifysourcecode": {
              const address = params.get("contractaddress").toLowerCase()
              submissions.push(address)
              expect(params.get("codeformat")).to.equal(
                "solidity-standard-json-input"
              )
              expect(Object.keys(JSON.parse(params.get("sourceCode")).sources))
                .not.to.be.empty
              if (address === proxy.toLowerCase()) {
                expect(params.get("constructorArguements")).to.equal(
                  ethers.AbiCoder.defaultAbiCoder()
                    .encode(
                      ["address", "address", "bytes"],
                      [implementation, admin, "0x"]
                    )
                    .slice(2)
                )
              }
              result = `source-${address}`
              break
            }
            case "checkverifystatus":
              result = "Pass - Verified"
              break
            case "verifyproxycontract":
              expect(params.get("address")).to.equal(proxy)
              expect(params.get("expectedimplementation")).to.equal(
                implementation
              )
              if (rejectLink)
                return {
                  statusCode: 200,
                  data: {
                    status: "0",
                    message: "NOTOK",
                    result: "Proxy link rejected",
                  },
                }
              result = "proxy-link-guid"
              break
            case "checkproxyverification":
              expect(params.get("guid")).to.equal("proxy-link-guid")
              linkChecked = true
              result = "Pass - Verified"
              break
            default:
              throw new Error(`Unexpected explorer action: ${action}`)
          }
          return {
            statusCode: 200,
            data: { status: "1", message: "OK", result },
          }
        }
      )
      .persist()

    const verification = hre.run("verify:etherscan", {
      address: proxy,
      // Avoid scanning unrelated build-info files for the implementation.
      contract: "contracts/depositor/NativeBTCDepositor.sol:NativeBTCDepositor",
    })
    if (rejectLink) {
      await expect(verification).to.be.rejectedWith("Proxy link rejected")
    } else {
      await verification
      expect(linkChecked).to.equal(true)
    }
    expect(submissions).to.have.members(
      [implementation, proxy, admin].map((address) => address.toLowerCase())
    )
    expect(discoveries).to.have.members(
      [proxy, admin].map((address) => address.toLowerCase())
    )
  }

  it("verifies the implementation, legacy proxy and shared admin through the registered task", async () => {
    await verifyProxy(false)
  })

  it("fails the registered task when the explorer rejects the proxy link", async () => {
    await verifyProxy(true)
  })
})
