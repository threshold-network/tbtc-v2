export type DisabledGatewayHardhatRuntimeEnvironment = {
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

  const isDeprecatePolygonTag =
    process.argv.includes("--tags") &&
    process.argv[process.argv.indexOf("--tags") + 1]
      ?.split(",")
      .includes("DeprecatePolygon")
  const envRequireSupport = process.env.REQUIRE_DISABLED_GATEWAY_SUPPORT

  let encodedDisabledGateway: string | undefined
  let error: unknown

  try {
    encodedDisabledGateway = await hre.ethers.provider.call({
      to: gatewayAddress,
      data: hre.ethers.utils.id("DISABLED_GATEWAY()").slice(0, 10),
    })
  } catch (e: unknown) {
    error = e
    const isCallException =
      isErrorWithCode(error) && error.code === "CALL_EXCEPTION"

    if (!isCallException) {
      throw error
    }
  }

  return evaluateDisabledGatewaySupport(
    encodedDisabledGateway,
    disabledGateway,
    error,
    isDeprecatePolygonTag,
    envRequireSupport,
    hre,
    gatewayName,
    destinationName
  )
}

export function evaluateDisabledGatewaySupport(
  callResult: string | undefined,
  disabledGateway: string,
  error: unknown,
  isDeprecatePolygonTag: boolean,
  envRequireSupport: string | undefined,
  hre: DisabledGatewayHardhatRuntimeEnvironment,
  gatewayName: string,
  destinationName: string
): boolean {
  const isSupported =
    callResult?.toLowerCase() === disabledGateway.toLowerCase()
  const isStrict = envRequireSupport === "true" || isDeprecatePolygonTag

  if (isSupported) {
    return true
  }

  const errorMessage = error instanceof Error ? error.message : String(error)
  const message =
    `${gatewayName} is not upgraded with disabled gateway support; ` +
    `skipping ${destinationName} gateway block. The existing gateway ` +
    "mapping remains unchanged, so coordinate the remote deprecation " +
    "steps before relying on exit-only behavior. Upgrade the gateway " +
    "implementation, then rerun this deployment." +
    (error ? ` Call failure: ${errorMessage}` : "")

  if (isStrict) {
    throw new Error(message)
  }

  hre.deployments.log(message)
  return false
}

function isErrorWithCode(error: unknown): error is { code: unknown } {
  return typeof error === "object" && error !== null && "code" in error
}
