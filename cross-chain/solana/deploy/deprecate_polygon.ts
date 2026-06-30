import * as anchor from "@coral-xyz/anchor"
import fs from "fs"
import { Keypair, PublicKey } from "@solana/web3.js"
import dotenv from "dotenv"
import { Program } from "@coral-xyz/anchor"
import { WormholeGateway } from "../target/types/wormhole_gateway"

const WH_POLYGON_CHAIN_ID = 5
const ZERO_GATEWAY_ADDRESS = Array.from(Buffer.alloc(32))

async function run(): Promise<void> {
  dotenv.config({ path: "../solana.env" })

  anchor.setProvider(anchor.AnchorProvider.env())

  const wormholeGatewayProgram = anchor.workspace
    .WormholeGateway as Program<WormholeGateway>
  assertZeroGatewayGuard(wormholeGatewayProgram)

  const authority = loadKey(process.env.AUTHORITY).publicKey

  const custodian = PublicKey.findProgramAddressSync(
    [Buffer.from("redeemer")],
    wormholeGatewayProgram.programId
  )[0]

  const encodedPolygonChain = Buffer.alloc(2)
  encodedPolygonChain.writeUInt16LE(WH_POLYGON_CHAIN_ID)
  const gatewayPolygonInfo = PublicKey.findProgramAddressSync(
    [Buffer.from("gateway-info"), encodedPolygonChain],
    wormholeGatewayProgram.programId
  )[0]

  await wormholeGatewayProgram.methods
    .updateGatewayAddress({
      chain: WH_POLYGON_CHAIN_ID,
      address: ZERO_GATEWAY_ADDRESS,
    })
    .accounts({
      custodian,
      gatewayInfo: gatewayPolygonInfo,
      authority,
    })
    .rpc()

  console.log("Cleared Solana gateway Polygon peer")
}

function assertZeroGatewayGuard(program: Program<WormholeGateway>): void {
  const hasZeroGatewayGuard = program.idl.errors?.some(
    ({ name }) => name === "ZeroGateway"
  )

  if (!hasZeroGatewayGuard) {
    throw new Error(
      "Refusing to clear Polygon gateway peer before deploying the ZeroGateway send guard"
    )
  }
}

;(async () => {
  try {
    await run()
  } catch (e) {
    console.log("Exception called:", e)
  }
})()

function loadKey(filename: string): Keypair {
  try {
    const contents = fs.readFileSync(filename).toString()
    const bs = Uint8Array.from(JSON.parse(contents))

    return Keypair.fromSecretKey(bs)
  } catch {
    console.log("Unable to read keypair...", filename)
  }
}
