import { deprecatePeer } from "./helpers/deprecate_peer"

export { assertDisabledGatewaySupport } from "./helpers/deprecate_peer"

const WH_OPTIMISM_CHAIN_ID = 24

async function main() {
  try {
    await deprecatePeer(WH_OPTIMISM_CHAIN_ID, "Optimism")
  } catch (e) {
    console.error(e)
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}
