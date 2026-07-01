declare const process: {
  env: Record<string, string | undefined>
}

type DisabledGatewayHardhatRuntimeEnvironment = {
  network: { name: string }
  ethers: {
    provider: {
      call(transaction: { to: string; data: string }): Promise<string>
    }
    utils: {
      id(text: string): string
    }
  }
  deployments: {
    log(message: string): void
  }
}

export async function isDisabledGatewaySupported(
  hre: DisabledGatewayHardhatRuntimeEnvironment,
  gatewayAddress: string,
  gatewayName: string,
  destinationName: string,
  disabledGateway: string
): Promise<boolean> {
  if (hre.network.name === "hardhat") {
    return true
  }

  let encodedDisabledGateway: string
  try {
    encodedDisabledGateway = await hre.ethers.provider.call({
      to: gatewayAddress,
      data: hre.ethers.utils.id("DISABLED_GATEWAY()").slice(0, 10),
    })
  } catch (error) {
    return handleUnsupportedDisabledGateway(
      hre,
      gatewayName,
      destinationName,
      (error as Error).message
    )
  }

  if (encodedDisabledGateway.toLowerCase() === disabledGateway) {
    return true
  }

  return handleUnsupportedDisabledGateway(hre, gatewayName, destinationName)
}

function handleUnsupportedDisabledGateway(
  hre: DisabledGatewayHardhatRuntimeEnvironment,
  gatewayName: string,
  destinationName: string,
  reason?: string
): boolean {
  const message =
    `${gatewayName} is not upgraded with disabled gateway support; ` +
    `skipping ${destinationName} gateway block. The existing gateway ` +
    "mapping remains unchanged, so coordinate the remote deprecation " +
    "steps before relying on exit-only behavior. Upgrade the gateway " +
    "implementation, then rerun this deployment." +
    (reason ? ` Call failure: ${reason}` : "")

  if (process.env.REQUIRE_DISABLED_GATEWAY_SUPPORT === "true") {
    throw new Error(message)
  }

  hre.deployments.log(message)
  return false
}
