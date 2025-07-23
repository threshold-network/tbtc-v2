import { ethers, getNamedAccounts, upgrades } from "hardhat"
import { expect } from "chai"

describe("BurnFromMintTokenPoolUpgradeable", function () {
  let deployer: string
  let contract: any
  let user: any

  beforeEach(async function () {
    const signers = await ethers.getSigners()
    deployer = signers[0].address
    user = signers[1]
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock")
    const token = await ERC20Mock.deploy("Mock tBTC", "tBTC", deployer, ethers.utils.parseEther("1000000"))
    await token.deployed()
    const TestPool = await ethers.getContractFactory("BurnFromMintTokenPoolUpgradeableTest")
    const proxy = await upgrades.deployProxy(TestPool, [token.address, [], ethers.constants.AddressZero, ethers.constants.AddressZero], { initializer: "initialize" })
    await proxy.deployed()
    contract = proxy
  })

  it("should be deployed and initialized", async function () {
    expect(contract.address).to.properAddress
    expect(await contract.owner()).to.equal(deployer)
    expect(await contract.typeAndVersion()).to.include("BurnFromMintTokenPoolUpgradeable")
  })

  it("should have correct initial state", async function () {
    expect(await contract.s_router()).to.equal(ethers.constants.AddressZero)
    expect(await contract.s_rmnProxy()).to.equal(ethers.constants.AddressZero)
    // Allowlist should be empty
    // (no public getter, so we skip direct check)
  })

  it("should revert lockOrBurn if not called by router", async function () {
    await expect(
      contract.lockOrBurn({
        receiver: ethers.utils.hexlify(ethers.utils.toUtf8Bytes("dummy")),
        remoteChainSelector: 0,
        originalSender: user.address,
        amount: 100,
        localToken: await contract.s_token(),
        extraArgs: "0x"
      })
    ).to.be.revertedWith("Only router")
  })

  it("should allow mint and burn via mock token", async function () {
    const tokenAddr = await contract.s_token()
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock")
    const token = ERC20Mock.attach(tokenAddr)
    // Mint some tokens to user
    await token.mint(user.address, 1000)
    expect(await token.balanceOf(user.address)).to.equal(1000)
    // Burn tokens from user (simulate router call)
    // For this, we need to set s_router to user.address (using test-only setter)
    await contract.setRouter(user.address)
    await token.connect(user).approve(contract.address, 500)
    // Now call lockOrBurn as router
    await expect(
      contract.connect(user).lockOrBurn({
        receiver: ethers.utils.hexlify(ethers.utils.toUtf8Bytes("dummy")),
        remoteChainSelector: 0,
        originalSender: user.address,
        amount: 500,
        localToken: tokenAddr,
        extraArgs: "0x"
      })
    ).to.emit(contract, "Burned").withArgs(user.address, 500)
    expect(await token.balanceOf(user.address)).to.equal(500)
  })

  // Add more tests for pool logic as needed
}) 