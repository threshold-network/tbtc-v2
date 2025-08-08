describe("Debug", function () {
  it("Should deploy contract", async function () {
    const [owner, user1, user2, router, rmnProxy, rebalancer] =
      await ethers.getSigners()
    const MockERC20 = await ethers.getContractFactory("ERC20Mock")
    const mockToken = await MockERC20.deploy(
      "Mock Token",
      "MTK",
      owner.address,
      ethers.utils.parseEther("1000000")
    )
    await mockToken.deployed()

    const LockReleaseTokenPoolUpgradeable = await ethers.getContractFactory(
      "LockReleaseTokenPoolUpgradeable"
    )
    const lockReleasePool = await upgrades.deployProxy(
      LockReleaseTokenPoolUpgradeable,
      [mockToken.address, 18, [], rmnProxy.address, true, router.address]
    )
    await lockReleasePool.deployed()

    console.log("Contract deployed at:", lockReleasePool.address)
    console.log("Token address:", await lockReleasePool.getToken())
    console.log("Router address:", await lockReleasePool.getRouter())
    console.log("Available functions:", Object.keys(lockReleasePool.functions))
  })
})
