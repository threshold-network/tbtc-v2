import * as anchor from "@coral-xyz/anchor"
import * as crypto from "crypto"
import fs from "fs"
import { Keypair, PublicKey } from "@solana/web3.js"
import dotenv from "dotenv"
import { Idl, Program } from "@coral-xyz/anchor"
import { WormholeGateway } from "../target/types/wormhole_gateway"

const WH_POLYGON_CHAIN_ID = 5
const DISABLED_GATEWAY_ADDRESS = Array.from(
  Buffer.concat([Buffer.alloc(31), Buffer.from([1])])
)
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
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

export function assertDisabledGatewaySupport(idl: Idl, source: string): void {
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
  await assertDeployedProgramDataHash(program)
}

// `anchor idl upgrade` writes the on-chain IDL independently of `anchor
// upgrade` (the program binary). Passing the two IDL checks above only proves
// the *IDL* advertises disabled-gateway support -- it says nothing about
// whether the *binary* actually enforces it. Guard against that split by
// requiring the operator to supply the ProgramData hash captured immediately
// after their most recent `anchor upgrade` (e.g. via
// `solana program dump <programId> - | sha256sum`, or the equivalent of the
// hash this function computes, recorded right after that upgrade completes)
// and refusing to proceed unless the currently deployed binary still matches
// it. There is no live validator/toolchain available to build a local
// reference binary here, so a byte-for-byte compare against a freshly
// rebuilt `.so` (the original suggestion) is left to the operator's own CI;
// this hash check is the automatable half of that verification.
async function assertDeployedProgramDataHash(
  program: Program<WormholeGateway>
): Promise<void> {
  const expectedHash = process.env.EXPECTED_PROGRAM_DATA_HASH
  if (!expectedHash) {
    throw new Error(
      "Refusing to disable Polygon gateway peer: EXPECTED_PROGRAM_DATA_HASH is " +
        "not set. Capture the deployed program's data hash immediately after " +
        "the last verified `anchor upgrade` and pass it via this env var -- " +
        "an IDL-only check cannot prove the binary itself enforces the " +
        "disabled-gateway guard."
    )
  }

  const provider = program.provider as anchor.AnchorProvider
  const [programDataAddress] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID
  )
  const programDataAccount = await provider.connection.getAccountInfo(
    programDataAddress
  )
  if (!programDataAccount) {
    throw new Error(
      `Refusing to disable Polygon gateway peer: no ProgramData account found ` +
        `at ${programDataAddress.toBase58()} for program ${program.programId.toBase58()}`
    )
  }

  const actualHash = crypto
    .createHash("sha256")
    .update(programDataAccount.data)
    .digest("hex")

  if (actualHash !== expectedHash.toLowerCase()) {
    throw new Error(
      `Refusing to disable Polygon gateway peer: deployed ProgramData hash ` +
        `${actualHash} does not match EXPECTED_PROGRAM_DATA_HASH ` +
        `${expectedHash}. The deployed binary may not match the verified ` +
        `\`anchor upgrade\` this deprecation depends on.`
    )
  }
}

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

async function main() {
  try {
    await run()
  } catch (e) {
    console.error(e)
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}
