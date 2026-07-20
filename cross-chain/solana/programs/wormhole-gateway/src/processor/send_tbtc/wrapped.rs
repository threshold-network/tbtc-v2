use crate::{
    constants::{DISABLED_GATEWAY, MSG_SEED_PREFIX},
    error::WormholeGatewayError,
    state::{Custodian, GatewayInfo},
};
use anchor_lang::prelude::*;
use anchor_spl::token;
use wormhole_anchor_sdk::{
    token_bridge::{self, program::TokenBridge},
    wormhole::{self as core_bridge, program::Wormhole as CoreBridge},
};

#[derive(Accounts)]
#[instruction(args: SendTbtcWrappedArgs)]
pub struct SendTbtcWrapped<'info> {
    #[account(
        mut,
        seeds = [Custodian::SEED_PREFIX],
        bump = custodian.bump,
        has_one = wrapped_tbtc_token,
        has_one = wrapped_tbtc_mint,
        has_one = tbtc_mint,
    )]
    custodian: Account<'info, Custodian>,

    /// CHECK: Gateway info for the recipient chain, seeds-pinned to
    /// `recipient_chain`. It is mandatory (not optional) so the caller cannot
    /// bypass the disabled-gateway check by omitting or substituting it — the
    /// seeds constraint forces the caller to pass the canonical PDA for the
    /// chain. It is an `UncheckedAccount` because gateway-less chains (the plain
    /// wrapped-transfer path, mirroring the EVM `gateway == bytes32(0)` branch)
    /// have no initialized `GatewayInfo` PDA. The instruction body branches on
    /// the account's on-chain state: program-owned (initialized) is deserialized
    /// and checked for the disabled sentinel; empty/uninitialized means the
    /// chain has no registered gateway and the send is allowed.
    #[account(
        seeds = [GatewayInfo::SEED_PREFIX, &args.recipient_chain.to_le_bytes()],
        bump,
    )]
    gateway_info: UncheckedAccount<'info>,

    /// Custody account.
    #[account(mut)]
    wrapped_tbtc_token: Box<Account<'info, token::TokenAccount>>,

    /// CHECK: This account is needed for the Token Bridge program.
    #[account(mut)]
    wrapped_tbtc_mint: UncheckedAccount<'info>,

    #[account(mut)]
    tbtc_mint: Box<Account<'info, token::Mint>>,

    #[account(
        mut,
        token::mint = tbtc_mint,
        token::authority = sender
    )]
    sender_token: Box<Account<'info, token::TokenAccount>>,

    #[account(mut)]
    sender: Signer<'info>,

    /// CHECK: This account is needed for the Token Bridge program.
    token_bridge_config: UncheckedAccount<'info>,

    /// CHECK: This account is needed for the Token Bridge program.
    token_bridge_wrapped_asset: UncheckedAccount<'info>,

    /// CHECK: This account is needed for the Token Bridge program.
    token_bridge_transfer_authority: UncheckedAccount<'info>,

    /// CHECK: This account is needed for the Token Bridge program.
    #[account(mut)]
    core_bridge_data: UncheckedAccount<'info>,

    /// CHECK: This account is needed for the Token Bridge program.
    #[account(
        mut,
        seeds = [
            MSG_SEED_PREFIX,
            &core_emitter_sequence.value().to_le_bytes()
        ],
        bump
    )]
    core_message: AccountInfo<'info>,

    /// CHECK: This account is needed for the Token Bridge program.
    token_bridge_core_emitter: UncheckedAccount<'info>,

    /// CHECK: This account is needed for the Token Bridge program.
    #[account(mut)]
    core_emitter_sequence: Account<'info, core_bridge::SequenceTracker>,

    /// CHECK: This account is needed for the Token Bridge program.
    #[account(mut)]
    core_fee_collector: UncheckedAccount<'info>,

    /// CHECK: This account is needed for the Token Bridge program.
    clock: UncheckedAccount<'info>,

    /// CHECK: This account is needed for the Token Bridge program.
    rent: UncheckedAccount<'info>,

    token_bridge_program: Program<'info, TokenBridge>,
    core_bridge_program: Program<'info, CoreBridge>,
    token_program: Program<'info, token::Token>,
    system_program: Program<'info, System>,
}

impl<'info> SendTbtcWrapped<'info> {
    fn constraints(ctx: &Context<Self>, args: &SendTbtcWrappedArgs) -> Result<()> {
        super::validate_send(
            &ctx.accounts.wrapped_tbtc_token,
            &args.recipient,
            args.amount,
        )
    }
}

#[derive(Debug, Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SendTbtcWrappedArgs {
    amount: u64,
    recipient_chain: u16,
    recipient: [u8; 32],
    arbiter_fee: u64,
    nonce: u32,
}

#[access_control(SendTbtcWrapped::constraints(&ctx, &args))]
pub fn send_tbtc_wrapped(ctx: Context<SendTbtcWrapped>, args: SendTbtcWrappedArgs) -> Result<()> {
    let SendTbtcWrappedArgs {
        amount,
        recipient_chain,
        recipient,
        arbiter_fee,
        nonce,
    } = args;

    let sender = &ctx.accounts.sender;
    let wrapped_tbtc_token = &ctx.accounts.wrapped_tbtc_token;
    let token_bridge_transfer_authority = &ctx.accounts.token_bridge_transfer_authority;
    let token_program = &ctx.accounts.token_program;

    // Reject the send if the destination chain's gateway has been disabled via
    // the sentinel. The `gateway_info` account is seeds-pinned to
    // `recipient_chain` and mandatory, so the caller cannot skip this check by
    // omitting or substituting the account. Branch on the account's on-chain
    // state, mirroring the EVM `gateways[chain]` storage read: if it is owned by
    // this program it is an initialized `GatewayInfo` carrying the chain's
    // gateway address — reject when that address is the disabled sentinel. If it
    // is uninitialized (empty / system-owned), the chain has no registered
    // gateway (the normal wrapped-transfer case, e.g. Ethereum) and the send is
    // allowed.
    let gateway_info_account = &ctx.accounts.gateway_info;
    if gateway_info_account.owner == ctx.program_id && !gateway_info_account.data_is_empty() {
        let gateway_info = Account::<GatewayInfo>::try_from(gateway_info_account)?;
        require!(
            gateway_info.address != DISABLED_GATEWAY,
            WormholeGatewayError::GatewayDisabled
        );
    }

    // Prepare for wrapped tBTC transfer.
    super::burn_and_prepare_transfer(
        super::PrepareTransfer {
            custodian: &mut ctx.accounts.custodian,
            tbtc_mint: &ctx.accounts.tbtc_mint,
            sender_token: &ctx.accounts.sender_token,
            sender,
            wrapped_tbtc_token,
            token_bridge_transfer_authority,
            token_program,
        },
        amount,
        recipient_chain,
        None, // gateway
        recipient,
        Some(arbiter_fee),
        nonce,
    )?;

    let custodian = &ctx.accounts.custodian;

    // Finally transfer wrapped tBTC to the recipient.
    token_bridge::transfer_wrapped(
        CpiContext::new_with_signer(
            ctx.accounts.token_bridge_program.to_account_info(),
            token_bridge::TransferWrapped {
                payer: sender.to_account_info(),
                config: ctx.accounts.token_bridge_config.to_account_info(),
                from: wrapped_tbtc_token.to_account_info(),
                from_owner: custodian.to_account_info(),
                wrapped_mint: ctx.accounts.wrapped_tbtc_mint.to_account_info(),
                wrapped_metadata: ctx.accounts.token_bridge_wrapped_asset.to_account_info(),
                authority_signer: token_bridge_transfer_authority.to_account_info(),
                wormhole_bridge: ctx.accounts.core_bridge_data.to_account_info(),
                wormhole_message: ctx.accounts.core_message.to_account_info(),
                wormhole_emitter: ctx.accounts.token_bridge_core_emitter.to_account_info(),
                wormhole_sequence: ctx.accounts.core_emitter_sequence.to_account_info(),
                wormhole_fee_collector: ctx.accounts.core_fee_collector.to_account_info(),
                clock: ctx.accounts.clock.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: token_program.to_account_info(),
                wormhole_program: ctx.accounts.core_bridge_program.to_account_info(),
            },
            &[
                &[Custodian::SEED_PREFIX, &[custodian.bump]],
                &[
                    MSG_SEED_PREFIX,
                    &ctx.accounts.core_emitter_sequence.value().to_le_bytes(),
                    &[ctx.bumps["core_message"]],
                ],
            ],
        ),
        nonce,
        amount,
        arbiter_fee,
        recipient,
        recipient_chain,
    )
}
