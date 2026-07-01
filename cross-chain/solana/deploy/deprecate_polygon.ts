import * as anchor from "@coral-xyz/anchor"
import fs from "fs"
import { Keypair, PublicKey } from "@solana/web3.js"
import dotenv from "dotenv"
import { Idl, Program } from "@coral-xyz/anchor"
import { WormholeGateway } from "../target/types/wormhole_gateway"

const WH_POLYGON_CHAIN_ID = 5
const DISABLED_GATEWAY_ADDRESS = Array.from(
  Buffer.concat([Buffer.alloc(31), Buffer.from([1])])
)

async function run(): Promise<void> {
  dotenv.config({ path: "../solana.env" })

  anchor.setProvider(anchor.AnchorProvider.env())

  const wormholeGatewayProgram = anchor.workspace
    .WormholeGateway as Program<WormholeGateway>
  await assertDeployedDisabledGatewaySupport(wormholeGatewayProgram)

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
      address: DISABLED_GATEWAY_ADDRESS,
    })
    .accounts({
      custodian,
      gatewayInfo: gatewayPolygonInfo,
      authority,
    })
    .rpc()

  console.log("Disabled Solana gateway Polygon peer")
}

function assertDisabledGatewaySupport(idl: Idl, source: string): void {
  const hasDisabledGatewayGuard = idl.errors?.some(
    ({ name }) => name === "GatewayDisabled"
  )
  const sendWrappedAccounts =
    idl.instructions.find(({ name }) => name === "sendTbtcWrapped")?.accounts ??
    []
  const sendWrappedChecksGatewayInfo = sendWrappedAccounts.some(
    ({ name }) => name === "gatewayInfo"
  )

  if (!hasDisabledGatewayGuard || !sendWrappedChecksGatewayInfo) {
    throw new Error(
      `Refusing to disable Polygon gateway peer because ${source} does not include disabled-gateway send guards`
    )
  }
}

async function assertDeployedDisabledGatewaySupport(
  program: Program<WormholeGateway>
): Promise<void> {
  assertDisabledGatewaySupport(program.idl, "the local IDL")

  const provider = program.provider as anchor.AnchorProvider
  const deployedIdl = await Program.fetchIdl(program.programId, provider)

  if (!deployedIdl) {
    throw new Error(
      "Refusing to disable Polygon gateway peer because the deployed Anchor IDL was not found"
    )
  }

  assertDisabledGatewaySupport(deployedIdl, "the deployed Anchor IDL")
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
