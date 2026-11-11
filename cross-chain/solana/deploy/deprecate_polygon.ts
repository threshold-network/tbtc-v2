import { deprecatePeer } from "./helpers/deprecate_peer"

export { assertDisabledGatewaySupport } from "./helpers/deprecate_peer"

const WH_POLYGON_CHAIN_ID = 5

async function main() {
  try {
    await deprecatePeer(WH_POLYGON_CHAIN_ID, "Polygon")
  } catch (e) {
    console.error(e)
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}
