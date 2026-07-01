import * as anchor from "@coral-xyz/anchor"
import fs from "fs"
import { Keypair, PublicKey } from "@solana/web3.js"
import dotenv from "dotenv"
import { Idl, Program } from "@coral-xyz/anchor"
import { WormholeGateway } from "../target/types/wormhole_gateway"

const WH_POLYGON_CHAIN_ID = 5
const ZERO_GATEWAY_ADDRESS = Array.from(Buffer.alloc(32))

async function run(): Promise<void> {
  dotenv.config({ path: "../solana.env" })

  anchor.setProvider(anchor.AnchorProvider.env())

  const wormholeGatewayProgram = anchor.workspace
    .WormholeGateway as Program<WormholeGateway>
  await assertDeployedZeroGatewayGuard(wormholeGatewayProgram)

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

function assertZeroGatewayGuard(idl: Idl, source: string): void {
  const hasZeroGatewayGuard = idl.errors?.some(
    ({ name }) => name === "ZeroGateway"
  )

  if (!hasZeroGatewayGuard) {
    throw new Error(
      `Refusing to clear Polygon gateway peer because ${source} does not include the ZeroGateway send guard`
    )
  }
}

async function assertDeployedZeroGatewayGuard(
  program: Program<WormholeGateway>
): Promise<void> {
  assertZeroGatewayGuard(program.idl, "the local IDL")

  const provider = program.provider as anchor.AnchorProvider
  const deployedIdl = await Program.fetchIdl(program.programId, provider)

  if (!deployedIdl) {
    throw new Error(
      "Refusing to clear Polygon gateway peer because the deployed Anchor IDL was not found"
    )
  }

  assertZeroGatewayGuard(deployedIdl, "the deployed Anchor IDL")
}

;(async () => {
  try {
    await run()
  } catch (e) {
    console.log("Exception called:", e)
    process.exitCode = 1
  }
})()

function loadKey(filename?: string): Keypair {
  if (!filename) {
    throw new Error("AUTHORITY environment variable is required")
  }

  try {
    const contents = fs.readFileSync(filename).toString()
    const bs = Uint8Array.from(JSON.parse(contents))

    return Keypair.fromSecretKey(bs)
  } catch (error) {
    throw new Error(
      `Unable to read keypair ${filename}: ${(error as Error).message}`
    )
  }
}
