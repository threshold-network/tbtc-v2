import * as anchor from "@coral-xyz/anchor"
import * as crypto from "crypto"
import fs from "fs"
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js"
import dotenv from "dotenv"
import { Idl, Program } from "@coral-xyz/anchor"
import { WormholeGateway } from "../../target/types/wormhole_gateway"

const DISABLED_GATEWAY_ADDRESS = Array.from(
  Buffer.concat([Buffer.alloc(31), Buffer.from([1])])
)
// UpgradeableLoaderState::size_of_programdata_metadata()
const PROGRAM_DATA_METADATA_SIZE = 45
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
)

export type AuthorityMode = "sign" | "multisig"

// The custodian authority is the only account that may call
// `update_gateway_address`. On mainnet it is a Squads vault, an off-curve PDA
// with no secret key, so the update has to go through the multisig. A local
// keypair is used only when it is the custodian authority itself.
export function resolveAuthorityMode(
  authority: PublicKey,
  signer?: Keypair
): AuthorityMode {
  if (!signer) {
    return "multisig"
  }

  if (!signer.publicKey.equals(authority)) {
    throw new Error(
      `AUTHORITY ${signer.publicKey.toBase58()} is not the gateway custodian ` +
        `authority ${authority.toBase58()}. Unset AUTHORITY to produce the ` +
        "instruction for the authority's multisig instead."
    )
  }

  return "sign"
}

export async function deprecatePeer(
  chainId: number,
  chainName: string
): Promise<void> {
  dotenv.config({ path: "../solana.env" })

  anchor.setProvider(anchor.AnchorProvider.env())

  const wormholeGatewayProgram = anchor.workspace
    .WormholeGateway as Program<WormholeGateway>
  await assertDeployedDisabledGatewaySupport(wormholeGatewayProgram, chainName)

  const custodian = PublicKey.findProgramAddressSync(
    [Buffer.from("redeemer")],
    wormholeGatewayProgram.programId
  )[0]
  const { authority } = await wormholeGatewayProgram.account.custodian.fetch(
    custodian
  )

  const encodedChain = Buffer.alloc(2)
  encodedChain.writeUInt16LE(chainId)
  const gatewayInfo = PublicKey.findProgramAddressSync(
    [Buffer.from("gateway-info"), encodedChain],
    wormholeGatewayProgram.programId
  )[0]

  const update = wormholeGatewayProgram.methods
    .updateGatewayAddress({
      chain: chainId,
      address: DISABLED_GATEWAY_ADDRESS,
    })
    .accounts({
      custodian,
      gatewayInfo,
      authority,
    })

  const signer = process.env.AUTHORITY
    ? loadKey(process.env.AUTHORITY)
    : undefined

  if (resolveAuthorityMode(authority, signer) === "sign") {
    await update.signers([signer as Keypair]).rpc()
    console.log(`Disabled Solana gateway ${chainName} peer`)
    return
  }

  const instruction = await update.instruction()
  const outPath =
    process.env.MULTISIG_INSTRUCTION_OUT ??
    `deprecate-${chainName.toLowerCase()}.multisig-instruction.json`
  await writeMultisigInstruction(
    wormholeGatewayProgram,
    instruction,
    authority,
    chainId,
    chainName,
    outPath
  )
  console.log(
    `Custodian authority ${authority.toBase58()} ` +
      `${
        PublicKey.isOnCurve(authority.toBytes())
          ? "has no local signer"
          : "is an off-curve PDA (a multisig vault)"
      }. ` +
      `Wrote the ${chainName} peer update for multisig execution to ${outPath}.`
  )
}

// Writes the instruction for the authority's multisig (for example a Squads
// vault transaction) and simulates it with the authority as the only signer
// and fee payer, without signature checks, so a wrong account or a missing
// program upgrade fails here instead of in the multisig.
async function writeMultisigInstruction(
  program: Program<WormholeGateway>,
  instruction: TransactionInstruction,
  authority: PublicKey,
  chainId: number,
  chainName: string,
  outPath: string
): Promise<void> {
  const provider = program.provider as anchor.AnchorProvider
  const { blockhash } = await provider.connection.getLatestBlockhash()
  const message = new TransactionMessage({
    payerKey: authority,
    recentBlockhash: blockhash,
    instructions: [instruction],
  }).compileToLegacyMessage()

  const simulation = await provider.connection.simulateTransaction(
    new VersionedTransaction(message),
    { sigVerify: false, replaceRecentBlockhash: true }
  )
  if (simulation.value.err) {
    throw new Error(
      `Simulation of the ${chainName} peer update failed: ` +
        `${JSON.stringify(simulation.value.err)}\n` +
        `${(simulation.value.logs ?? []).join("\n")}`
    )
  }

  const { bs58 } = anchor.utils.bytes
  fs.writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        description: `Set the Solana gateway ${chainName} peer (Wormhole chain ${chainId}) to DISABLED_GATEWAY`,
        authority: authority.toBase58(),
        authorityIsOnCurve: PublicKey.isOnCurve(authority.toBytes()),
        instruction: {
          programId: instruction.programId.toBase58(),
          keys: instruction.keys.map(({ pubkey, isSigner, isWritable }) => ({
            pubkey: pubkey.toBase58(),
            isSigner,
            isWritable,
          })),
          dataHex: instruction.data.toString("hex"),
          dataBase58: bs58.encode(instruction.data),
        },
        unsignedMessageBase58: bs58.encode(message.serialize()),
        simulationLogs: simulation.value.logs ?? [],
      },
      null,
      2
    )}\n`
  )
}

export function assertDisabledGatewaySupport(
  idl: Idl,
  source: string,
  chainName = "the"
): void {
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
      `Refusing to disable ${chainName} gateway peer because ${source} does not include disabled-gateway send guards`
    )
  }
}

async function assertDeployedDisabledGatewaySupport(
  program: Program<WormholeGateway>,
  chainName: string
): Promise<void> {
  assertDisabledGatewaySupport(program.idl, "the local IDL", chainName)

  const provider = program.provider as anchor.AnchorProvider
  const deployedIdl = await Program.fetchIdl(program.programId, provider)

  if (!deployedIdl) {
    throw new Error(
      `Refusing to disable ${chainName} gateway peer because the deployed Anchor IDL was not found`
    )
  }

  assertDisabledGatewaySupport(
    deployedIdl,
    "the deployed Anchor IDL",
    chainName
  )
  await assertDeployedProgramDataHash(program, chainName)
}

// `anchor idl upgrade` writes the on-chain IDL independently of `anchor
// upgrade` (the program binary). Passing the two IDL checks above only proves
// the *IDL* advertises disabled-gateway support -- it says nothing about
// whether the *binary* actually enforces it. Guard against that split by
// requiring the operator to supply the ProgramData hash captured immediately
// after their most recent `anchor upgrade` (e.g. via
// `solana program dump <programId> program.so && sha256sum program.so`, the
// same bytes this function hashes, recorded right after that upgrade completes)
// and refusing to proceed unless the currently deployed binary still matches
// it. There is no live validator/toolchain available to build a local
// reference binary here, so a byte-for-byte compare against a freshly
// rebuilt `.so` (the original suggestion) is left to the operator's own CI;
// this hash check is the automatable half of that verification.
async function assertDeployedProgramDataHash(
  program: Program<WormholeGateway>,
  chainName: string
): Promise<void> {
  const expectedHash = process.env.EXPECTED_PROGRAM_DATA_HASH
  if (!expectedHash) {
    throw new Error(
      `Refusing to disable ${chainName} gateway peer: EXPECTED_PROGRAM_DATA_HASH is ` +
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
      `Refusing to disable ${chainName} gateway peer: no ProgramData account found ` +
        `at ${programDataAddress.toBase58()} for program ${program.programId.toBase58()}`
    )
  }

  // `solana program dump` writes the ProgramData account without its
  // 45-byte upgradeable-loader metadata header (state tag, slot, upgrade
  // authority); hash exactly those bytes.
  const actualHash = crypto
    .createHash("sha256")
    .update(programDataAccount.data.subarray(PROGRAM_DATA_METADATA_SIZE))
    .digest("hex")

  if (actualHash !== expectedHash.toLowerCase()) {
    throw new Error(
      `Refusing to disable ${chainName} gateway peer: deployed ProgramData hash ` +
        `${actualHash} does not match EXPECTED_PROGRAM_DATA_HASH ` +
        `${expectedHash}. The deployed binary may not match the verified ` +
        `\`anchor upgrade\` this deprecation depends on.`
    )
  }
}

function loadKey(filename: string): Keypair {
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
