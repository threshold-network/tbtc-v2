use crate::{
    error::WormholeGatewayError,
    state::{Custodian, GatewayInfo},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(args: UpdateGatewayAddressArgs)]
pub struct UpdateGatewayAddress<'info> {
    #[account(
        seeds = [Custodian::SEED_PREFIX],
        bump = custodian.bump,
        has_one = authority @ WormholeGatewayError::IsNotAuthority,
    )]
    custodian: Account<'info, Custodian>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + GatewayInfo::INIT_SPACE,
        seeds = [GatewayInfo::SEED_PREFIX, &args.chain.to_le_bytes()],
        bump,
    )]
    gateway_info: Account<'info, GatewayInfo>,

    #[account(mut)]
    authority: Signer<'info>,

    system_program: Program<'info, System>,
}

#[derive(Debug, Clone, AnchorSerialize, AnchorDeserialize)]
pub struct UpdateGatewayAddressArgs {
    chain: u16,
    address: [u8; 32],
}

pub fn update_gateway_address(
    ctx: Context<UpdateGatewayAddress>,
    args: UpdateGatewayAddressArgs,
) -> Result<()> {
    let UpdateGatewayAddressArgs { chain, address } = args;

    ctx.accounts.gateway_info.set_inner(GatewayInfo {
        bump: ctx.bumps["gateway_info"],
        address,
    });

    emit!(crate::event::GatewayAddressUpdated {
        chain,
        gateway: address
    });

    Ok(())
}
