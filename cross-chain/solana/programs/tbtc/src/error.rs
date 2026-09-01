use anchor_lang::prelude::error_code;

#[error_code]
pub enum TbtcError {
    #[msg("Not valid authority to perform this action")]
    IsNotAuthority = 0x20,

    #[msg("Not valid pending authority to take authority")]
    IsNotPendingAuthority = 0x22,

    #[msg("No pending authority")]
    NoPendingAuthorityChange = 0x24,

    #[msg("This address is already a guardian")]
    GuardianAlreadyExists = 0x30,

    #[msg("This address is not a guardian")]
    GuardianNonexistent = 0x32,

    #[msg("Caller is not a guardian")]
    SignerNotGuardian = 0x34,

    #[msg("Guardian cannot be the authority")]
    GuardianCannotBeAuthority = 0x36,

    #[msg("This address is already a minter")]
    MinterAlreadyExists = 0x40,

    #[msg("This address is not a minter")]
    MinterNonexistent = 0x42,

    #[msg("Caller is not a minter")]
    SignerNotMinter = 0x44,

    #[msg("Program is paused")]
    IsPaused = 0x50,

    #[msg("Program is not paused")]
    IsNotPaused = 0x52,

    #[msg("Mint supply must be zero")]
    MintSupplyNotZero = 0x54,

    #[msg("All minters must be removed")]
    MintersStillConfigured = 0x56,

    #[msg("New mint authority cannot be the default pubkey")]
    NewMintAuthorityCannotBeDefault = 0x58,

    #[msg("At least two guardians must be registered to transfer mint authority")]
    InsufficientGuardiansForMintAuthorityTransfer = 0x5A,
}
