use crate::{
    error::TbtcError,
    state::{Config, GuardianInfo, Guardians},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct AddGuardian<'info> {
    #[account(
        mut,
        seeds = [Config::SEED_PREFIX],
        bump,
        has_one = authority @ TbtcError::IsNotAuthority
    )]
    config: Account<'info, Config>,

    #[account(mut)]
    authority: Signer<'info>,

    #[account(
        mut,
        seeds = [Guardians::SEED_PREFIX],
        bump = guardians.bump,
        realloc = Guardians::compute_size(guardians.keys.len() + 1),
        realloc::payer = authority,
        realloc::zero = true,
    )]
    guardians: Account<'info, Guardians>,

    #[account(
        init,
        payer = authority,
        space = 8 + GuardianInfo::INIT_SPACE,
        seeds = [GuardianInfo::SEED_PREFIX, guardian.key().as_ref()],
        bump
    )]
    guardian_info: Account<'info, GuardianInfo>,

    /// CHECK: Required authority to pause contract. This pubkey lives in `GuardianInfo` and
    /// `Guardians`.
    #[account(
        constraint = guardian.key() != authority.key()
            @ TbtcError::GuardianCannotBeAuthority
    )]
    guardian: AccountInfo<'info>,

    system_program: Program<'info, System>,
}

pub fn add_guardian(ctx: Context<AddGuardian>) -> Result<()> {
    let guardian = ctx.accounts.guardian.key();

    // Set account data.
    ctx.accounts.guardian_info.set_inner(GuardianInfo {
        bump: ctx.bumps["guardian_info"],
        guardian,
    });

    // Push pubkey to guardians account.
    ctx.accounts.guardians.push(guardian);

    // Update config.
    ctx.accounts.config.num_guardians += 1;

    emit!(crate::event::GuardianAdded { guardian });

    Ok(())
}
