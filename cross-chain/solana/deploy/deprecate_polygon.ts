import * as anchor from "@coral-xyz/anchor"
import crypto from "crypto"
import fs from "fs"
import path from "path"
import { Keypair, PublicKey } from "@solana/web3.js"
import dotenv from "dotenv"
import { Program } from "@coral-xyz/anchor"
import { WormholeGateway } from "../target/types/wormhole_gateway"

const WH_POLYGON_CHAIN_ID = 5
const ZERO_GATEWAY_ADDRESS = Array.from(Buffer.alloc(32))
const LOCAL_WORMHOLE_GATEWAY_PROGRAM_PATH = path.join(
  __dirname,
  "../target/deploy/wormhole_gateway.so"
)
const UPGRADEABLE_LOADER_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
)
const PROGRAMDATA_STATE_TAG = 3
// Upgradeable loader ProgramData layout: 4-byte enum tag, 8-byte slot,
// 1-byte authority option, and 32-byte authority pubkey.
const PROGRAMDATA_DATA_OFFSET = 45

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

async function assertDeployedZeroGatewayGuard(
  program: Program<WormholeGateway>
): Promise<void> {
  assertZeroGatewayGuard(program)

  if (!fs.existsSync(LOCAL_WORMHOLE_GATEWAY_PROGRAM_PATH)) {
    throw new Error(
      `Refusing to clear Polygon gateway peer before building ${LOCAL_WORMHOLE_GATEWAY_PROGRAM_PATH}. Run anchor build from cross-chain/solana first.`
    )
  }

  const localProgramData = fs.readFileSync(LOCAL_WORMHOLE_GATEWAY_PROGRAM_PATH)
  const provider = program.provider as anchor.AnchorProvider
  const [programDataAddress] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    UPGRADEABLE_LOADER_PROGRAM_ID
  )
  const programDataAccount = await provider.connection.getAccountInfo(
    programDataAddress
  )

  if (!programDataAccount) {
    throw new Error(
      `Refusing to clear Polygon gateway peer because deployed ProgramData account ${programDataAddress.toBase58()} was not found`
    )
  }

  if (!programDataAccount.owner.equals(UPGRADEABLE_LOADER_PROGRAM_ID)) {
    throw new Error(
      `Refusing to clear Polygon gateway peer because ${programDataAddress.toBase58()} is not owned by the upgradeable loader`
    )
  }

  const deployedProgramData = readUpgradeableProgramData(
    Buffer.from(programDataAccount.data)
  )

  if (deployedProgramData.length < localProgramData.length) {
    throw new Error(
      "Refusing to clear Polygon gateway peer because the deployed program data is shorter than the local build artifact"
    )
  }

  const deployedProgramHash = sha256(
    deployedProgramData.subarray(0, localProgramData.length)
  )
  const localProgramHash = sha256(localProgramData)
  const trailingProgramData = deployedProgramData.subarray(
    localProgramData.length
  )

  if (trailingProgramData.some((byte) => byte !== 0)) {
    throw new Error(
      "Refusing to clear Polygon gateway peer because the deployed program data has non-zero trailing bytes beyond the local build artifact"
    )
  }

  if (deployedProgramHash !== localProgramHash) {
    throw new Error(
      `Refusing to clear Polygon gateway peer because the deployed program does not match the local build artifact. deployed=${deployedProgramHash} local=${localProgramHash}`
    )
  }
}

function readUpgradeableProgramData(data: Buffer): Buffer {
  if (data.length < PROGRAMDATA_DATA_OFFSET) {
    throw new Error("Upgradeable ProgramData account is too short")
  }

  const stateTag = data.readUInt32LE(0)
  if (stateTag !== PROGRAMDATA_STATE_TAG) {
    throw new Error(
      `Expected upgradeable ProgramData account state ${PROGRAMDATA_STATE_TAG}, got ${stateTag}`
    )
  }

  return data.subarray(PROGRAMDATA_DATA_OFFSET)
}

function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex")
}

;(async () => {
  try {
    await run()
  } catch (e) {
    console.log("Exception called:", e)
    process.exitCode = 1
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
