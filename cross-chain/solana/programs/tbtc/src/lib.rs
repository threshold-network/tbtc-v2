#![allow(clippy::result_large_err)]

mod constants;
pub use constants::*;

pub mod error;

pub(crate) mod event;

mod processor;
pub(crate) use processor::*;

mod state;
pub use state::*;

use anchor_lang::prelude::*;

declare_id!("HksEtDgsXJV1BqcuhzbLRTmXp5gHgHJktieJCtQd3pG");

#[derive(Clone)]
pub struct Tbtc;

impl Id for Tbtc {
    fn id() -> Pubkey {
        ID
    }
}

#[program]
pub mod tbtc {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        processor::initialize(ctx)
    }

    pub fn change_authority(ctx: Context<ChangeAuthority>) -> Result<()> {
        processor::change_authority(ctx)
    }

    pub fn cancel_authority_change(ctx: Context<CancelAuthorityChange>) -> Result<()> {
        processor::cancel_authority_change(ctx)
    }

    pub fn take_authority(ctx: Context<TakeAuthority>) -> Result<()> {
        processor::take_authority(ctx)
    }

    pub fn add_minter(ctx: Context<AddMinter>) -> Result<()> {
        processor::add_minter(ctx)
    }

    pub fn remove_minter(ctx: Context<RemoveMinter>) -> Result<()> {
        processor::remove_minter(ctx)
    }

    pub fn add_guardian(ctx: Context<AddGuardian>) -> Result<()> {
        processor::add_guardian(ctx)
    }

    pub fn remove_guardian(ctx: Context<RemoveGuardian>) -> Result<()> {
        processor::remove_guardian(ctx)
    }

    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        processor::pause(ctx)
    }

    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        processor::unpause(ctx)
    }

    pub fn transfer_mint_authority(ctx: Context<TransferMintAuthority>) -> Result<()> {
        processor::transfer_mint_authority(ctx)
    }

    pub fn mint(ctx: Context<Mint>, amount: u64) -> Result<()> {
        processor::mint(ctx, amount)
    }
}
