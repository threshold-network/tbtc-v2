import { Program, AnchorProvider, Idl } from "@coral-xyz/anchor"
import { PublicKey, Transaction } from "@solana/web3.js"
import { BigNumber } from "ethers"
import {
  getMint,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token"

import { DestinationChainTBTCToken, ChainIdentifier } from "../contracts"
import SolanaTBTCTokenIdl from "./target/idl/tbtc.json"
import { SolanaAddress } from "./address"

/**
 * TBTC Token class that:
 * - Derives the mint PDA from the seed "tbtc-mint".
 * - Fetches balances & total supply via SPL Token.
 * - Manually creates a user’s ATA if needed (no direct Keypair usage).
 */
export class SolanaTBTCToken
  extends Program
  implements DestinationChainTBTCToken
{
  private tbtcMint: PublicKey

  constructor(provider: AnchorProvider) {
    if (!provider.wallet || !provider.wallet.publicKey) {
      throw new Error(
        "SolanaTBTCToken requires a connected wallet with a public key."
      )
    }
    const programId = new PublicKey(SolanaTBTCTokenIdl.metadata.address)

    super(SolanaTBTCTokenIdl as Idl, programId, provider)

    // derive your mint:
    this.tbtcMint = PublicKey.findProgramAddressSync(
      [Buffer.from("tbtc-mint")],
      programId
    )[0]
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * get the chain identifier from the program ID:
   */
  getChainIdentifier(): ChainIdentifier {
    return SolanaAddress.from(this.programId.toBase58())
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * Returns the user’s TBTC balance (in smallest token units).
   * If the associated token account does not exist, we create it
   * using a transaction signed by the connected wallet.
   */
  async balanceOf(identifier: ChainIdentifier): Promise<BigNumber> {
    if (!(this.provider as AnchorProvider).wallet?.publicKey) {
      throw new Error("No wallet connected.")
    }

    const userPubkey = new PublicKey(identifier.identifierHex)

    // Derive the ATA for (this.tbtcMint, userPubkey):
    const ataAddr = getAssociatedTokenAddressSync(this.tbtcMint, userPubkey)

    // Check if it exists:
    const ataInfo = await this.provider.connection.getAccountInfo(ataAddr)
    if (!ataInfo) {
      // Build a transaction to create the ATA:
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          (this.provider as AnchorProvider).wallet.publicKey, // Payer (must be a real signer)
          ataAddr,
          userPubkey,
          this.tbtcMint
        )
      )

      // Send and confirm the transaction. The Anchor provider will
      // prompt your wallet to sign it.
      await (this.provider as AnchorProvider).sendAndConfirm(tx)
    }

    // Now fetch the token balance in that ATA:
    const balanceInfo = await this.provider.connection.getTokenAccountBalance(
      ataAddr
    )
    return BigNumber.from(balanceInfo.value.amount)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * Fetches the total supply from the TBTC mint’s SPL Token account.
   */
  async totalSupply(): Promise<BigNumber> {
    const mintInfo = await getMint(this.provider.connection, this.tbtcMint)
    // `mintInfo.supply` is a bigint, so convert to BigNumber:
    return BigNumber.from(mintInfo.supply.toString())
  }
}
