use crate::{constants::SEED_PREFIX_TBTC_MINT, error::TbtcError, state::Config};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, spl_token::instruction::AuthorityType};

#[derive(Accounts)]
pub struct TransferMintAuthority<'info> {
    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
        has_one = authority @ TbtcError::IsNotAuthority,
        has_one = mint,
        constraint = config.paused @ TbtcError::IsNotPaused,
    )]
    config: Account<'info, Config>,

    authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_PREFIX_TBTC_MINT],
        bump = config.mint_bump,
        mint::authority = config,
    )]
    mint: Account<'info, token::Mint>,

    /// CHECK: Target SPL mint authority, typically the Wormhole NTT token authority PDA
    /// or a Token Program multisig that includes that PDA.
    new_authority: UncheckedAccount<'info>,

    token_program: Program<'info, token::Token>,
}

pub fn transfer_mint_authority(ctx: Context<TransferMintAuthority>) -> Result<()> {
    token::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::SetAuthority {
                account_or_mint: ctx.accounts.mint.to_account_info(),
                current_authority: ctx.accounts.config.to_account_info(),
            },
            &[&[Config::SEED_PREFIX, &[ctx.accounts.config.bump]]],
        ),
        AuthorityType::MintTokens,
        Some(ctx.accounts.new_authority.key()),
    )
}
