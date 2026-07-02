import { BN, Program, Wallet, workspace } from "@coral-xyz/anchor";
import { getMint } from "@solana/spl-token";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { config, expect } from "chai";
import { Tbtc } from "../../target/types/tbtc";
import { TBTC_PROGRAM_ID } from "./consts";
import { PROGRAM_ID as METADATA_PROGRAM_ID } from "@metaplex-foundation/mpl-token-metadata";

export function getConfigPDA(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    TBTC_PROGRAM_ID
  )[0];
}

export function getMintPDA(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tbtc-mint")],
    TBTC_PROGRAM_ID
  )[0];
}

export function getTbtcMetadataPDA(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METADATA_PROGRAM_ID.toBuffer(),
      getMintPDA().toBuffer(),
    ],
    METADATA_PROGRAM_ID
  )[0];
}

export function getMinterInfoPDA(minter: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("minter-info"), minter.toBuffer()],
    TBTC_PROGRAM_ID
  )[0];
}

export function getGuardianInfoPDA(guardian: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("guardian-info"), guardian.toBuffer()],
    TBTC_PROGRAM_ID
  )[0];
}

export function getGuardiansPDA(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("guardians")],
    TBTC_PROGRAM_ID
  )[0];
}

export function getMintersPDA(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("minters")],
    TBTC_PROGRAM_ID
  )[0];
}

export async function getConfigData() {
  const program = workspace.Tbtc as Program<Tbtc>;
  const config = getConfigPDA();
  return program.account.config.fetch(config);
}

export async function checkConfig(expected: {
  authority: PublicKey;
  numMinters: number;
  numGuardians: number;
  supply: bigint;
  paused: boolean;
  pendingAuthority: PublicKey | null;
  mintAuthority?: PublicKey | null;
}) {
  let {
    authority,
    numMinters,
    numGuardians,
    supply,
    paused,
    pendingAuthority,
    mintAuthority,
  } = expected;
  const program = workspace.Tbtc as Program<Tbtc>;
  const configState = await getConfigData();

  expect(configState.authority).to.eql(authority);
  expect(configState.numMinters).to.equal(numMinters);
  expect(configState.numGuardians).to.equal(numGuardians);
  expect(configState.paused).to.equal(paused);
  expect(configState.pendingAuthority).to.eql(pendingAuthority);

  const mintState = await getMint(
    program.provider.connection,
    configState.mint
  );
  expect(mintState.supply).to.equal(supply);
  if (mintAuthority !== undefined) {
    expect(mintState.mintAuthority).to.eql(mintAuthority);
  }

  const guardians = getGuardiansPDA();
  const guardiansState = await program.account.guardians.fetch(guardians);
  expect(guardiansState.keys).has.length(numGuardians);

  const minters = getMintersPDA();
  const mintersState = await program.account.minters.fetch(minters);
  expect(mintersState.keys).has.length(numMinters);
}

export async function getMinterInfo(minter: PublicKey) {
  const program = workspace.Tbtc as Program<Tbtc>;
  const minterInfoPDA = getMinterInfoPDA(minter);
  return program.account.minterInfo.fetch(minterInfoPDA);
}

export async function checkMinterInfo(minter: PublicKey) {
  const minterInfo = await getMinterInfo(minter);
  expect(minterInfo.minter).to.eql(minter);
}

export async function getGuardianInfo(guardian: PublicKey) {
  const program = workspace.Tbtc as Program<Tbtc>;
  const guardianInfoPDA = getGuardianInfoPDA(guardian);
  return program.account.guardianInfo.fetch(guardianInfoPDA);
}

export async function checkGuardianInfo(guardian: PublicKey) {
  let guardianInfo = await getGuardianInfo(guardian);
  expect(guardianInfo.guardian).to.eql(guardian);
}

type AddGuardianContext = {
  config?: PublicKey;
  authority: PublicKey;
  guardians?: PublicKey;
  guardianInfo?: PublicKey;
  guardian: PublicKey;
};

export async function addGuardianIx(
  accounts: AddGuardianContext
): Promise<TransactionInstruction> {
  const program = workspace.Tbtc as Program<Tbtc>;

  let { config, authority, guardians, guardianInfo, guardian } = accounts;
  if (config === undefined) {
    config = getConfigPDA();
  }

  if (guardians === undefined) {
    guardians = getGuardiansPDA();
  }

  if (guardianInfo === undefined) {
    guardianInfo = getGuardianInfoPDA(guardian);
  }

  return program.methods
    .addGuardian()
    .accounts({
      config,
      authority,
      guardians,
      guardianInfo,
      guardian,
    })
    .instruction();
}

type AddMinterContext = {
  config?: PublicKey;
  authority: PublicKey;
  minters?: PublicKey;
  minterInfo?: PublicKey;
  minter: PublicKey;
};

export async function addMinterIx(
  accounts: AddMinterContext
): Promise<TransactionInstruction> {
  const program = workspace.Tbtc as Program<Tbtc>;

  let { config, authority, minters, minterInfo, minter } = accounts;
  if (config === undefined) {
    config = getConfigPDA();
  }

  if (minters === undefined) {
    minters = getMintersPDA();
  }

  if (minterInfo === undefined) {
    minterInfo = getMinterInfoPDA(minter);
  }

  return program.methods
    .addMinter()
    .accounts({
      config,
      authority,
      minters,
      minterInfo,
      minter,
    })
    .instruction();
}

type CancelAuthorityChange = {
  config?: PublicKey;
  authority: PublicKey;
};

export async function cancelAuthorityChangeIx(
  accounts: CancelAuthorityChange
): Promise<TransactionInstruction> {
  const program = workspace.Tbtc as Program<Tbtc>;

  let { config, authority } = accounts;
  if (config === undefined) {
    config = getConfigPDA();
  }

  return program.methods
    .cancelAuthorityChange()
    .accounts({
      config,
      authority,
    })
    .instruction();
}

type ChangeAuthorityContext = {
  config?: PublicKey;
  authority: PublicKey;
  newAuthority: PublicKey;
};

export async function changeAuthorityIx(
  accounts: ChangeAuthorityContext
): Promise<TransactionInstruction> {
  const program = workspace.Tbtc as Program<Tbtc>;

  let { config, authority, newAuthority } = accounts;
  if (config === undefined) {
    config = getConfigPDA();
  }

  return program.methods
    .changeAuthority()
    .accounts({
      config,
      authority,
      newAuthority,
    })
    .instruction();
}

type InitializeContext = {
  mint?: PublicKey;
  config?: PublicKey;
  guardians?: PublicKey;
  minters?: PublicKey;
  authority: PublicKey;
  tbtcMetadata?: PublicKey;
  mplTokenMetadataProgram?: PublicKey;
};

export async function initializeIx(
  accounts: InitializeContext
): Promise<TransactionInstruction> {
  const program = workspace.Tbtc as Program<Tbtc>;

  let {
    mint,
    config,
    guardians,
    minters,
    authority,
    tbtcMetadata,
    mplTokenMetadataProgram,
  } = accounts;

  if (mint === undefined) {
    mint = getMintPDA();
  }

  if (config === undefined) {
    config = getConfigPDA();
  }

  if (guardians === undefined) {
    guardians = getGuardiansPDA();
  }

  if (minters === undefined) {
    minters = getMintersPDA();
  }

  if (tbtcMetadata === undefined) {
    tbtcMetadata = getTbtcMetadataPDA();
  }

  if (mplTokenMetadataProgram === undefined) {
    mplTokenMetadataProgram = METADATA_PROGRAM_ID;
  }

  return program.methods
    .initialize()
    .accounts({
      mint,
      config,
      guardians,
      minters,
      authority,
      tbtcMetadata,
      mplTokenMetadataProgram,
    })
    .instruction();
}

type PauseContext = {
  config?: PublicKey;
  guardianInfo?: PublicKey;
  guardian: PublicKey;
};

export async function pauseIx(
  accounts: PauseContext
): Promise<TransactionInstruction> {
  const program = workspace.Tbtc as Program<Tbtc>;

  let { config, guardianInfo, guardian } = accounts;
  if (config === undefined) {
    config = getConfigPDA();
  }

  if (guardianInfo === undefined) {
    guardianInfo = getGuardianInfoPDA(guardian);
  }

  return program.methods
    .pause()
    .accounts({
      config,
      guardianInfo,
      guardian,
    })
    .instruction();
}

type RemoveGuardianContext = {
  config?: PublicKey;
  authority: PublicKey;
  guardians?: PublicKey;
  guardianInfo?: PublicKey;
  guardian: PublicKey;
};

export async function removeGuardianIx(
  accounts: RemoveGuardianContext
): Promise<TransactionInstruction> {
  const program = workspace.Tbtc as Program<Tbtc>;

  let { config, authority, guardians, guardianInfo, guardian } = accounts;
  if (config === undefined) {
    config = getConfigPDA();
  }

  if (guardians === undefined) {
    guardians = getGuardiansPDA();
  }

  if (guardianInfo === undefined) {
    guardianInfo = getGuardianInfoPDA(guardian);
  }

  return program.methods
    .removeGuardian()
    .accounts({
      config,
      authority,
      guardians,
      guardianInfo,
      guardian,
    })
    .instruction();
}

type RemoveMinterContext = {
  config?: PublicKey;
  authority: PublicKey;
  minters?: PublicKey;
  minterInfo?: PublicKey;
  minter: PublicKey;
};

export async function removeMinterIx(
  accounts: RemoveMinterContext
): Promise<TransactionInstruction> {
  const program = workspace.Tbtc as Program<Tbtc>;

  let { config, authority, minters, minterInfo, minter } = accounts;
  if (config === undefined) {
    config = getConfigPDA();
  }

  if (minters === undefined) {
    minters = getMintersPDA();
  }

  if (minterInfo === undefined) {
    minterInfo = getMinterInfoPDA(minter);
  }

  return program.methods
    .removeMinter()
    .accounts({
      config,
      authority,
      minters,
      minterInfo,
      minter,
    })
    .instruction();
}

type TakeAuthorityContext = {
  config?: PublicKey;
  pendingAuthority: PublicKey;
};

export async function takeAuthorityIx(
  accounts: TakeAuthorityContext
): Promise<TransactionInstruction> {
  const program = workspace.Tbtc as Program<Tbtc>;

  let { config, pendingAuthority } = accounts;
  if (config === undefined) {
    config = getConfigPDA();
  }

  return program.methods
    .takeAuthority()
    .accounts({
      config,
      pendingAuthority,
    })
    .instruction();
}

type UnpauseContext = {
  config?: PublicKey;
  authority: PublicKey;
};

export async function unpauseIx(
  accounts: UnpauseContext
): Promise<TransactionInstruction> {
  const program = workspace.Tbtc as Program<Tbtc>;

  let { config, authority } = accounts;
  if (config === undefined) {
    config = getConfigPDA();
  }

  return program.methods
    .unpause()
    .accounts({
      config,
      authority,
    })
    .instruction();
}

type TransferMintAuthorityContext = {
  config?: PublicKey;
  authority: PublicKey;
  mint?: PublicKey;
  guardianInfo?: PublicKey;
  guardian: PublicKey;
  newAuthority: PublicKey;
};

export async function transferMintAuthorityIx(
  accounts: TransferMintAuthorityContext
): Promise<TransactionInstruction> {
  const program = workspace.Tbtc as Program<Tbtc>;

  let { config, authority, mint, guardianInfo, guardian, newAuthority } =
    accounts;
  if (config === undefined) {
    config = getConfigPDA();
  }

  if (mint === undefined) {
    mint = getMintPDA();
  }

  if (guardianInfo === undefined) {
    guardianInfo = getGuardianInfoPDA(guardian);
  }

  return program.methods
    .transferMintAuthority()
    .accounts({
      config,
      authority,
      mint,
      guardianInfo,
      guardian,
      newAuthority,
    })
    .instruction();
}

type MintContext = {
  mint?: PublicKey;
  config?: PublicKey;
  minterInfo?: PublicKey;
  minter: PublicKey;
  recipientToken: PublicKey;
};

export async function mintIx(
  accounts: MintContext,
  amount: BN
): Promise<TransactionInstruction> {
  const program = workspace.Tbtc as Program<Tbtc>;

  let { mint, config, minterInfo, minter, recipientToken } = accounts;
  if (mint === undefined) {
    mint = getMintPDA();
  }

  if (config === undefined) {
    config = getConfigPDA();
  }

  if (minterInfo === undefined) {
    minterInfo = getMinterInfoPDA(minter);
  }

  return program.methods
    .mint(amount)
    .accounts({
      mint,
      config,
      minterInfo,
      minter,
      recipientToken,
    })
    .instruction();
}
