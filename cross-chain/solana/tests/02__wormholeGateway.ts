import { MockEthereumTokenBridge } from "@certusone/wormhole-sdk/lib/cjs/mock";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { WormholeGateway } from "../target/types/wormhole_gateway";
import {
  ETHEREUM_TOKEN_BRIDGE_ADDRESS,
  WORMHOLE_GATEWAY_PROGRAM_ID,
  WRAPPED_TBTC_MINT,
  ethereumGatewaySendTbtc,
  expectIxFail,
  expectIxSuccess,
  generatePayer,
  getOrCreateAta,
  preloadWrappedTbtc,
  transferLamports,
} from "./helpers";
import * as tbtc from "./helpers/tbtc";
import * as wormholeGateway from "./helpers/wormholeGateway";

async function setup(
  program: Program<WormholeGateway>,
  authority,
  mintingLimit: bigint
) {
  const custodian = wormholeGateway.getCustodianPDA();
  const tbtcMint = tbtc.getMintPDA();
  const gatewayWrappedTbtcToken = wormholeGateway.getWrappedTbtcTokenPDA();
  const tokenBridgeSender = wormholeGateway.getTokenBridgeSenderPDA();

  await program.methods
    .initialize(new anchor.BN(mintingLimit.toString()))
    .accounts({
      authority: authority.publicKey,
      custodian,
      tbtcMint,
      wrappedTbtcMint: WRAPPED_TBTC_MINT,
      wrappedTbtcToken: gatewayWrappedTbtcToken,
      tokenBridgeSender,
    })
    .rpc();
}

describe("wormhole-gateway", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  // Initialize anchor program.
  const program = anchor.workspace.WormholeGateway as Program<WormholeGateway>;
  const connection = program.provider.connection;

  const custodian = wormholeGateway.getCustodianPDA();
  const tbtcMint = tbtc.getMintPDA();
  const tbtcConfig = tbtc.getConfigPDA();
  const gatewayWrappedTbtcToken = wormholeGateway.getWrappedTbtcTokenPDA();
  const tokenBridgeSender = wormholeGateway.getTokenBridgeSenderPDA();
  const tokenBridgeRedeemer = wormholeGateway.getTokenBridgeRedeemerPDA();

  const authority = (
    (program.provider as anchor.AnchorProvider).wallet as anchor.Wallet
  ).payer;
  const newAuthority = anchor.web3.Keypair.generate();
  const minterKeys = anchor.web3.Keypair.generate();
  const minter2Keys = anchor.web3.Keypair.generate();
  const imposter = anchor.web3.Keypair.generate();
  const guardianKeys = anchor.web3.Keypair.generate();
  const guardian2Keys = anchor.web3.Keypair.generate();

  const recipient = anchor.web3.Keypair.generate();
  const txPayer = anchor.web3.Keypair.generate();

  const commonTokenOwner = anchor.web3.Keypair.generate();
  const DISABLED_GATEWAY_ADDRESS = Array.from(
    Buffer.concat([Buffer.alloc(31), Buffer.from([1])])
  );

  // Mock foreign emitter.
  const ethereumTokenBridge = new MockEthereumTokenBridge(
    ETHEREUM_TOKEN_BRIDGE_ADDRESS
  );

  it("set up payers", async () => {
    await transferLamports(authority, newAuthority.publicKey, 10000000000);
    await transferLamports(authority, imposter.publicKey, 10000000000);
    await transferLamports(authority, recipient.publicKey, 10000000000);
    await transferLamports(authority, txPayer.publicKey, 10000000000);
    await transferLamports(authority, commonTokenOwner.publicKey, 10000000000);
  });

  describe("setup", () => {
    it("initialize", async () => {
      // Max amount of TBTC that can be minted.
      const mintingLimit = BigInt(10000);

      // Initialize the program.
      await setup(program, authority, mintingLimit);
      await wormholeGateway.checkCustodian({
        authority: authority.publicKey,
        mintingLimit,
        pendingAuthority: null,
      });
      await tbtc.checkConfig({
        authority: authority.publicKey,
        numMinters: 0,
        numGuardians: 0,
        supply: BigInt(2000),
        paused: false,
        pendingAuthority: null,
      });

      // Also set up common token account.
      await getOrCreateAta(
        authority,
        tbtc.getMintPDA(),
        commonTokenOwner.publicKey
      );

      // Give the impostor some lamports.
      await transferLamports(authority, imposter.publicKey, 100000000000);
    });
  });

  describe("authority changes", () => {
    it("cannot cancel authority if no pending", async () => {
      const failedCancelIx = await wormholeGateway.cancelAuthorityChangeIx({
        authority: authority.publicKey,
      });
      await expectIxFail(
        [failedCancelIx],
        [authority],
        "NoPendingAuthorityChange"
      );
    });

    it("cannot take authority if no pending", async () => {
      const failedTakeIx = await wormholeGateway.takeAuthorityIx({
        pendingAuthority: newAuthority.publicKey,
      });
      await expectIxFail(
        [failedTakeIx],
        [newAuthority],
        "NoPendingAuthorityChange"
      );
    });

    it("change authority to new authority", async () => {
      const changeIx = await wormholeGateway.changeAuthorityIx({
        authority: authority.publicKey,
        newAuthority: newAuthority.publicKey,
      });
      await expectIxSuccess([changeIx], [authority]);
      await wormholeGateway.checkCustodian({
        authority: authority.publicKey,
        mintingLimit: BigInt(10000),
        pendingAuthority: newAuthority.publicKey,
      });
    });

    it("take as new authority", async () => {
      // Bug in validator? Need to wait a bit for new blockhash.
      //await sleep(10000);

      const takeIx = await wormholeGateway.takeAuthorityIx({
        pendingAuthority: newAuthority.publicKey,
      });
      await expectIxSuccess([takeIx], [newAuthority]);
      await wormholeGateway.checkCustodian({
        authority: newAuthority.publicKey,
        mintingLimit: BigInt(10000),
        pendingAuthority: null,
      });
    });

    it("change pending authority back to original authority", async () => {
      const changeBackIx = await wormholeGateway.changeAuthorityIx({
        authority: newAuthority.publicKey,
        newAuthority: authority.publicKey,
      });
      await expectIxSuccess([changeBackIx], [newAuthority]);
      await wormholeGateway.checkCustodian({
        authority: newAuthority.publicKey,
        mintingLimit: BigInt(10000),
        pendingAuthority: authority.publicKey,
      });
    });

    it("cannot take as signers that are not pending authority", async () => {
      const failedImposterTakeIx = await wormholeGateway.takeAuthorityIx({
        pendingAuthority: imposter.publicKey,
      });
      await expectIxFail(
        [failedImposterTakeIx],
        [imposter],
        "IsNotPendingAuthority"
      );

      const failedNewAuthorityTakeIx = await wormholeGateway.takeAuthorityIx({
        pendingAuthority: newAuthority.publicKey,
      });
      await expectIxFail(
        [failedNewAuthorityTakeIx],
        [newAuthority],
        "IsNotPendingAuthority"
      );
    });

    it("cannot cancel as someone else", async () => {
      const anotherFailedCancelIx =
        await wormholeGateway.cancelAuthorityChangeIx({
          authority: authority.publicKey,
        });
      await expectIxFail(
        [anotherFailedCancelIx],
        [authority],
        "IsNotAuthority"
      );
    });

    it("finally take as authority", async () => {
      const anotherTakeIx = await wormholeGateway.takeAuthorityIx({
        pendingAuthority: authority.publicKey,
      });
      await expectIxSuccess([anotherTakeIx], [authority]);
      await wormholeGateway.checkCustodian({
        authority: authority.publicKey,
        mintingLimit: BigInt(10000),
        pendingAuthority: null,
      });
    });
  });

  describe("minting limit", () => {
    it("update minting limit", async () => {
      // Update minting limit as authority.
      const newLimit = BigInt(20000);
      const ix = await wormholeGateway.updateMintingLimitIx(
        {
          authority: authority.publicKey,
        },
        newLimit
      );
      await expectIxSuccess([ix], [authority]);
      await wormholeGateway.checkCustodian({
        authority: authority.publicKey,
        mintingLimit: newLimit,
        pendingAuthority: null,
      });
    });

    it("cannot update minting limit (not authority)", async () => {
      // Only the authority can update the minting limit.
      const newLimit = BigInt(69000);
      const failingIx = await wormholeGateway.updateMintingLimitIx(
        {
          authority: imposter.publicKey,
        },
        newLimit
      );
      await expectIxFail([failingIx], [imposter], "IsNotAuthority");
    });
  });

  describe("gateway address", () => {
    const chain = 2;

    it("gateway does not exist", async () => {
      // demonstrate gateway address does not exist
      const gatewayInfo = await connection.getAccountInfo(
        wormholeGateway.getGatewayInfoPDA(chain)
      );
      expect(gatewayInfo).is.null;
    });

    it("set initial gateway address", async () => {
      // Make new gateway.
      const firstAddress = Array.from(Buffer.alloc(32, "deadbeef", "hex"));
      const firstIx = await wormholeGateway.updateGatewayAddress(
        {
          authority: authority.publicKey,
        },
        { chain, address: firstAddress }
      );
      await expectIxSuccess([firstIx], [authority]);
      await wormholeGateway.checkGateway(chain, firstAddress);
    });

    it("update gateway address", async () => {
      // Update gateway.
      const goodAddress = Array.from(ethereumTokenBridge.address);
      const secondIx = await wormholeGateway.updateGatewayAddress(
        {
          authority: authority.publicKey,
        },
        { chain, address: goodAddress }
      );
      await expectIxSuccess([secondIx], [authority]);
      await wormholeGateway.checkGateway(chain, goodAddress);
    });

    it("cannot update gateway address (not authority)", async () => {
      // Only the authority can update the gateway address.
      const goodAddress = Array.from(ethereumTokenBridge.address);
      const failingIx = await wormholeGateway.updateGatewayAddress(
        {
          authority: imposter.publicKey,
        },
        { chain, address: goodAddress }
      );
      await expectIxFail([failingIx], [imposter], "IsNotAuthority");
    });
  });

  describe("deposit wrapped tbtc", () => {
    it("cannot deposit wrapped tbtc (custodian not a minter)", async () => {
      // Set up new wallet
      const payer = await generatePayer(authority);

      // Check wrapped tBTC mint.
      const recipientWrappedToken = await preloadWrappedTbtc(
        payer,
        ethereumTokenBridge,
        BigInt("100000000000"),
        payer.publicKey
      );

      const recipientToken = await getOrCreateAta(
        payer,
        tbtcMint,
        payer.publicKey
      );

      const depositAmount = BigInt(500);

      // Attempt to deposit before the custodian is a minter.
      const ix = await wormholeGateway.depositWormholeTbtcIx(
        {
          recipientWrappedToken,
          recipientToken,
          recipient: payer.publicKey,
        },
        depositAmount
      );
      await expectIxFail([ix], [payer], "AccountNotInitialized");
    });

    it("deposit wrapped tokens", async () => {
      // Set up new wallet
      const payer = await generatePayer(authority);

      // Check wrapped tBTC mint.
      const recipientWrappedToken = await preloadWrappedTbtc(
        payer,
        ethereumTokenBridge,
        BigInt("100000000000"),
        payer.publicKey
      );

      const recipientToken = await getOrCreateAta(
        payer,
        tbtcMint,
        payer.publicKey
      );

      const mintedAmountBefore = await wormholeGateway.getMintedAmount();

      const depositAmount = BigInt(500);

      const ix = await wormholeGateway.depositWormholeTbtcIx(
        {
          recipientWrappedToken,
          recipientToken,
          recipient: payer.publicKey,
        },
        depositAmount
      );

      // Add custodian as minter.
      const addMinterIx = await tbtc.addMinterIx({
        authority: authority.publicKey,
        minter: custodian,
      });
      await expectIxSuccess([addMinterIx], [authority]);
      await tbtc.checkConfig({
        authority: authority.publicKey,
        numMinters: 1,
        numGuardians: 0,
        supply: BigInt(2000),
        paused: false,
        pendingAuthority: null,
      });

      // Check token account balances before deposit.
      const [wrappedBefore, tbtcBefore, gatewayBefore] = await Promise.all([
        getAccount(connection, recipientWrappedToken),
        getAccount(connection, recipientToken),
        getAccount(connection, gatewayWrappedTbtcToken),
      ]);

      await expectIxSuccess([ix], [payer]);
      await tbtc.checkConfig({
        authority: authority.publicKey,
        numMinters: 1,
        numGuardians: 0,
        supply: BigInt(2500),
        paused: false,
        pendingAuthority: null,
      });

      const [wrappedAfter, tbtcAfter, gatewayAfter] = await Promise.all([
        getAccount(connection, recipientWrappedToken),
        getAccount(connection, recipientToken),
        getAccount(connection, gatewayWrappedTbtcToken),
      ]);

      // Check minted amount after.
      const mintedAmountAfter = await wormholeGateway.getMintedAmount();
      expect(mintedAmountAfter).to.equal(mintedAmountBefore + depositAmount);

      // Check balance change.
      expect(wrappedAfter.amount).to.equal(
        wrappedBefore.amount - depositAmount
      );
      expect(tbtcAfter.amount).to.equal(tbtcBefore.amount + depositAmount);
      expect(gatewayAfter.amount).to.equal(
        gatewayBefore.amount + depositAmount
      );
    });

    it("cannot deposit wrapped tbtc (minting limit exceeded)", async () => {
      // Set up new wallet
      const payer = await generatePayer(authority);

      // Check wrapped tBTC mint.
      const recipientWrappedToken = await preloadWrappedTbtc(
        payer,
        ethereumTokenBridge,
        BigInt("100000000000"),
        payer.publicKey
      );

      const recipientToken = await getOrCreateAta(
        payer,
        tbtcMint,
        payer.publicKey
      );

      // Cannot deposit past minting limit.
      const failingIx = await wormholeGateway.depositWormholeTbtcIx(
        {
          recipientWrappedToken,
          recipientToken,
          recipient: payer.publicKey,
        },
        BigInt(50000)
      );
      await expectIxFail([failingIx], [payer], "MintingLimitExceeded");
    });

    it("deposit wrapped tbtc after increasing mint limit", async () => {
      // Set up new wallet
      const payer = await generatePayer(authority);

      // Check wrapped tBTC mint.
      const recipientWrappedToken = await preloadWrappedTbtc(
        payer,
        ethereumTokenBridge,
        BigInt("100000000000"),
        payer.publicKey
      );

      const recipientToken = await getOrCreateAta(
        payer,
        tbtcMint,
        payer.publicKey
      );

      // Check minted amount before deposit.
      const mintedAmountBefore = await wormholeGateway.getMintedAmount();

      const depositAmount = BigInt(50000);

      // Cannot deposit past minting limit.
      const failingIx = await wormholeGateway.depositWormholeTbtcIx(
        {
          recipientWrappedToken,
          recipientToken,
          recipient: payer.publicKey,
        },
        depositAmount
      );

      // Will succeed if minting limit is increased.
      const newLimit = BigInt(70000);
      const updateLimitIx = await wormholeGateway.updateMintingLimitIx(
        {
          authority: authority.publicKey,
        },
        newLimit
      );
      await expectIxSuccess([updateLimitIx], [authority]);
      await wormholeGateway.checkCustodian({
        authority: authority.publicKey,
        mintingLimit: newLimit,
        pendingAuthority: null,
      });
      await expectIxSuccess([failingIx], [payer]);

      // Check minted amount after.
      const mintedAmountAfter = await wormholeGateway.getMintedAmount();
      expect(mintedAmountAfter).to.equal(mintedAmountBefore + depositAmount);
    });
  });

  describe("receive tbtc", () => {
    let replayVaa;

    it("receive tbtc", async () => {
      // Set up new wallet
      const payer = await generatePayer(authority);

      // Use common token account.
      const recipient = commonTokenOwner.publicKey;
      const recipientToken = getAssociatedTokenAddressSync(
        tbtc.getMintPDA(),
        recipient
      );

      // Get foreign gateway.
      const fromGateway = await wormholeGateway
        .getGatewayInfo(2)
        .then((info) => info.address);

      // Get minted amount before.
      const mintedAmountBefore = await wormholeGateway.getMintedAmount();

      const sentAmount = BigInt(5000);
      const signedVaa = await ethereumGatewaySendTbtc(
        payer,
        ethereumTokenBridge,
        sentAmount,
        fromGateway,
        WORMHOLE_GATEWAY_PROGRAM_ID,
        recipient
      );

      const [tbtcBefore, gatewayBefore] = await Promise.all([
        getAccount(connection, recipientToken),
        getAccount(connection, gatewayWrappedTbtcToken),
      ]);

      const ix = await wormholeGateway.receiveTbtcIx(
        {
          payer: payer.publicKey,
          recipientToken,
          recipient,
        },
        signedVaa
      );
      await expectIxSuccess([ix], [payer]);

      const [tbtcAfter, gatewayAfter] = await Promise.all([
        getAccount(connection, recipientToken),
        getAccount(connection, gatewayWrappedTbtcToken),
      ]);

      // Check balance change.
      expect(tbtcAfter.amount).to.equal(tbtcBefore.amount + sentAmount);
      expect(gatewayAfter.amount).to.equal(gatewayBefore.amount + sentAmount);

      // Check minted amount.
      const mintedAmountAfter = await wormholeGateway.getMintedAmount();
      expect(mintedAmountAfter).to.equal(mintedAmountBefore + sentAmount);

      // Save vaa.
      replayVaa = signedVaa;
    });

    it("cannot receive tbtc (vaa already redeemed)", async () => {
      // Set up new wallet
      const payer = await generatePayer(authority);

      // Use common token account.
      const recipient = commonTokenOwner.publicKey;
      const recipientToken = getAssociatedTokenAddressSync(
        tbtc.getMintPDA(),
        recipient
      );

      const ix = await wormholeGateway.receiveTbtcIx(
        {
          payer: payer.publicKey,
          recipientToken,
          recipient,
        },
        replayVaa
      );

      // Cannot receive tbtc again.
      await expectIxFail([ix], [payer], "TransferAlreadyRedeemed");
    });

    it("receive wrapped tbtc (ata doesn't exist)", async () => {
      // Set up new wallet
      const payer = await generatePayer(authority);

      // Use common token account.
      const recipient = commonTokenOwner.publicKey;
      const recipientToken = getAssociatedTokenAddressSync(
        tbtc.getMintPDA(),
        recipient
      );
      const recipientWrappedToken = getAssociatedTokenAddressSync(
        WRAPPED_TBTC_MINT,
        recipient
      );

      // Get minted amount before.
      const mintedAmountBefore = await wormholeGateway.getMintedAmount();

      // Verify that the wrapped token account doesn't exist yet.
      try {
        await getAccount(connection, recipientWrappedToken);
      } catch (e: any) {
        expect(e.toString()).to.equal("TokenAccountNotFoundError");
      }

      // Get foreign gateway.
      const fromGateway = await wormholeGateway
        .getGatewayInfo(2)
        .then((info) => info.address);

      // Create transfer VAA.
      const sentAmount = BigInt(5000);
      const signedVaa = await ethereumGatewaySendTbtc(
        payer,
        ethereumTokenBridge,
        sentAmount,
        fromGateway,
        WORMHOLE_GATEWAY_PROGRAM_ID,
        recipient
      );

      // Set the mint limit to a value smaller than sentAmount.
      const newLimit = sentAmount - BigInt(69);
      const updateLimitIx = await wormholeGateway.updateMintingLimitIx(
        {
          authority: authority.publicKey,
        },
        newLimit
      );
      await expectIxSuccess([updateLimitIx], [authority]);
      await wormholeGateway.checkCustodian({
        authority: authority.publicKey,
        mintingLimit: newLimit,
        pendingAuthority: null,
      });

      // Balance check before receiving wrapped tbtc. We can't
      // check the balance of the recipient's wrapped tbtc yet,
      // since the contract will create the ATA.
      const [tbtcBefore, gatewayBefore] = await Promise.all([
        getAccount(connection, recipientToken),
        getAccount(connection, gatewayWrappedTbtcToken),
      ]);

      const ix = await wormholeGateway.receiveTbtcIx(
        {
          payer: payer.publicKey,
          recipientToken,
          recipient,
        },
        signedVaa
      );
      await expectIxSuccess([ix], [payer]);

      // Check token accounts after receiving wrapped tbtc. We should
      // be able to fetch the recipient's wrapped tbtc now.
      const [tbtcAfter, wrappedTbtcAfter, gatewayAfter] = await Promise.all([
        getAccount(connection, recipientToken),
        getAccount(connection, recipientWrappedToken),
        getAccount(connection, gatewayWrappedTbtcToken),
      ]);

      // Check minted amount.
      const mintedAmountAfter = await wormholeGateway.getMintedAmount();
      expect(mintedAmountAfter).to.equal(mintedAmountBefore);

      // Check balance change.
      expect(tbtcAfter.amount).to.equal(tbtcBefore.amount);
      expect(gatewayAfter.amount).to.equal(gatewayBefore.amount);
      expect(wrappedTbtcAfter.amount).to.equal(sentAmount);
    });

    it("receive wrapped tbtc (ata exists)", async () => {
      // Set up new wallet
      const payer = await generatePayer(authority);

      // Use common token account.
      const recipient = commonTokenOwner.publicKey;
      const recipientToken = getAssociatedTokenAddressSync(
        tbtc.getMintPDA(),
        recipient
      );
      const recipientWrappedToken = await getOrCreateAta(
        payer,
        WRAPPED_TBTC_MINT,
        recipient
      );

      // Get foreign gateway.
      const fromGateway = await wormholeGateway
        .getGatewayInfo(2)
        .then((info) => info.address);

      // Get minted amount before.
      const mintedAmountBefore = await wormholeGateway.getMintedAmount();

      // Create transfer VAA.
      const sentAmount = BigInt(5000);
      const signedVaa = await ethereumGatewaySendTbtc(
        payer,
        ethereumTokenBridge,
        sentAmount,
        fromGateway,
        WORMHOLE_GATEWAY_PROGRAM_ID,
        recipient
      );

      // Set the mint limit to a value smaller than sentAmount.
      const newLimit = sentAmount - BigInt(69);
      const updateLimitIx = await wormholeGateway.updateMintingLimitIx(
        {
          authority: authority.publicKey,
        },
        newLimit
      );
      await expectIxSuccess([updateLimitIx], [authority]);
      await wormholeGateway.checkCustodian({
        authority: authority.publicKey,
        mintingLimit: newLimit,
        pendingAuthority: null,
      });

      // Balance check before receiving wrapped tbtc. If this
      // line successfully executes, then the recipient's
      // wrapped tbtc account already exists.
      const [tbtcBefore, wrappedTbtcBefore, gatewayBefore] = await Promise.all([
        getAccount(connection, recipientToken),
        getAccount(connection, recipientWrappedToken),
        getAccount(connection, gatewayWrappedTbtcToken),
      ]);

      const ix = await wormholeGateway.receiveTbtcIx(
        {
          payer: payer.publicKey,
          recipientToken,
          recipient,
        },
        signedVaa
      );
      await expectIxSuccess([ix], [payer]);

      // Check token accounts after receiving wrapped tbtc.
      const [tbtcAfter, wrappedTbtcAfter, gatewayAfter] = await Promise.all([
        getAccount(connection, recipientToken),
        getAccount(connection, recipientWrappedToken),
        getAccount(connection, gatewayWrappedTbtcToken),
      ]);

      // Check minted amount.
      const mintedAmountAfter = await wormholeGateway.getMintedAmount();
      expect(mintedAmountAfter).to.equal(mintedAmountBefore);

      // Check balance change.
      expect(tbtcAfter.amount).to.equal(tbtcBefore.amount);
      expect(gatewayAfter.amount).to.equal(gatewayBefore.amount);
      expect(wrappedTbtcAfter.amount).to.equal(
        wrappedTbtcBefore.amount + sentAmount
      );
    });

    it("cannot receive non-tbtc transfers", async () => {
      // Set up new wallet
      const payer = await generatePayer(authority);

      // Use common token account.
      const recipient = commonTokenOwner.publicKey;
      const recipientToken = getAssociatedTokenAddressSync(
        tbtc.getMintPDA(),
        recipient
      );

      // Get foreign gateway.
      const fromGateway = await wormholeGateway
        .getGatewayInfo(2)
        .then((info) => info.address);

      const sentAmount = BigInt(5000);
      const signedVaa = await ethereumGatewaySendTbtc(
        payer,
        ethereumTokenBridge,
        sentAmount,
        fromGateway,
        WORMHOLE_GATEWAY_PROGRAM_ID,
        recipient,
        "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH address
        69 // hehe
      );

      const failingIx = await wormholeGateway.receiveTbtcIx(
        {
          payer: payer.publicKey,
          recipientToken,
          recipient,
        },
        signedVaa
      );
      await expectIxFail([failingIx], [payer], "InvalidEthereumTbtc");
    });

    it("cannot receive zero-amount tbtc transfers", async () => {
      // Set up new wallet
      const payer = await generatePayer(authority);

      // Use common token account.
      const recipient = commonTokenOwner.publicKey;
      const recipientToken = getAssociatedTokenAddressSync(
        tbtc.getMintPDA(),
        recipient
      );

      // Get foreign gateway.
      const fromGateway = await wormholeGateway
        .getGatewayInfo(2)
        .then((info) => info.address);

      const sentAmount = BigInt(0);
      const signedVaa = await ethereumGatewaySendTbtc(
        payer,
        ethereumTokenBridge,
        sentAmount,
        fromGateway,
        WORMHOLE_GATEWAY_PROGRAM_ID,
        recipient
      );

      const failingIx = await wormholeGateway.receiveTbtcIx(
        {
          payer: payer.publicKey,
          recipientToken,
          recipient,
        },
        signedVaa
      );
      await expectIxFail([failingIx], [payer], "NoTbtcTransferred");
    });

    it("cannot receive tbtc transfer with zero address as recipient", async () => {
      // Set up new wallet
      const payer = await generatePayer(authority);

      // Use common token account. Set the recipient to the zero address.
      const recipient = PublicKey.default;
      const defaultTokenAccount = await getOrCreateAta(
        payer,
        tbtc.getMintPDA(),
        recipient
      );

      // Get foreign gateway.
      const fromGateway = await wormholeGateway
        .getGatewayInfo(2)
        .then((info) => info.address);

      const sentAmount = BigInt(100);
      const signedVaa = await ethereumGatewaySendTbtc(
        payer,
        ethereumTokenBridge,
        sentAmount,
        fromGateway,
        WORMHOLE_GATEWAY_PROGRAM_ID,
        recipient
      );

      const failingIx = await wormholeGateway.receiveTbtcIx(
        {
          payer: payer.publicKey,
          recipientToken: defaultTokenAccount,
          recipient,
        },
        signedVaa
      );
      await expectIxFail([failingIx], [payer], "RecipientZeroAddress");
    });
  });

  describe("send tbtc", () => {
    it("send tbtc to gateway", async () => {
      // Use common token account.
      const sender = commonTokenOwner.publicKey;
      const senderToken = getAssociatedTokenAddressSync(
        tbtc.getMintPDA(),
        sender
      );

      // Check token accounts.
      const [senderTbtcBefore, gatewayBefore] = await Promise.all([
        getAccount(connection, senderToken),
        getAccount(connection, gatewayWrappedTbtcToken),
      ]);

      // Check minted amount before.
      const mintedAmountBefore = await wormholeGateway.getMintedAmount();

      // Get destination gateway.
      const recipientChain = 2;
      const recipient = Array.from(Buffer.alloc(32, "deadbeef", "hex"));
      const nonce = 420;

      // This should work.
      const sendAmount = BigInt(2000);
      const ix = await wormholeGateway.sendTbtcGatewayIx(
        {
          senderToken,
          sender,
        },
        {
          amount: new anchor.BN(sendAmount.toString()),
          recipientChain,
          recipient,
          nonce,
        }
      );
      await expectIxSuccess([ix], [commonTokenOwner]);

      // Check token accounts after sending tbtc.
      const [senderTbtcAfter, gatewayAfter] = await Promise.all([
        getAccount(connection, senderToken),
        getAccount(connection, gatewayWrappedTbtcToken),
      ]);

      // Check minted amount.
      const mintedAmountAfter = await wormholeGateway.getMintedAmount();
      expect(mintedAmountAfter).to.equal(mintedAmountBefore - sendAmount);

      // Check balance change.
      expect(senderTbtcAfter.amount).to.equal(
        senderTbtcBefore.amount - sendAmount
      );
      expect(gatewayAfter.amount).to.equal(gatewayBefore.amount - sendAmount);
    });

    it("cannot send tbtc to gateway (insufficient wrapped balance)", async () => {
      // Use common token account.
      const sender = commonTokenOwner.publicKey;
      const senderToken = getAssociatedTokenAddressSync(
        tbtc.getMintPDA(),
        sender
      );

      // Get destination gateway.
      const recipientChain = 2;
      const recipient = Array.from(Buffer.alloc(32, "deadbeef", "hex"));
      const nonce = 420;

      // Check token accounts.
      const gatewayWrappedBalance = await getAccount(
        connection,
        gatewayWrappedTbtcToken
      );

      // Try an amount that won't work.
      const sendAmount = gatewayWrappedBalance.amount + BigInt(69);
      const ix = await wormholeGateway.sendTbtcGatewayIx(
        {
          senderToken,
          sender,
        },
        {
          amount: new anchor.BN(sendAmount.toString()),
          recipientChain,
          recipient,
          nonce,
        }
      );
      await expectIxFail([ix], [commonTokenOwner], "NotEnoughWrappedTbtc");
    });

    it("cannot send tbtc to gateway (zero amount)", async () => {
      // Use common token account.
      const sender = commonTokenOwner.publicKey;
      const senderToken = getAssociatedTokenAddressSync(
        tbtc.getMintPDA(),
        sender
      );

      // Get destination gateway.
      const recipientChain = 2;
      const recipient = Array.from(Buffer.alloc(32, "deadbeef", "hex"));
      const nonce = 420;

      // Try an amount that won't work.
      const sendAmount = BigInt(0);
      const ix = await wormholeGateway.sendTbtcGatewayIx(
        {
          senderToken,
          sender,
        },
        {
          amount: new anchor.BN(sendAmount.toString()),
          recipientChain,
          recipient,
          nonce,
        }
      );
      await expectIxFail([ix], [commonTokenOwner], "ZeroAmount");
    });

    it("cannot send tbtc to gateway (recipient is zero address)", async () => {
      // Use common token account.
      const sender = commonTokenOwner.publicKey;
      const senderToken = getAssociatedTokenAddressSync(
        tbtc.getMintPDA(),
        sender
      );

      // Get destination gateway.
      const recipientChain = 2;
      const recipient = Array.from(Buffer.alloc(32)); // empty buffer
      const nonce = 420;

      const sendAmount = BigInt(69);
      const ix = await wormholeGateway.sendTbtcGatewayIx(
        {
          senderToken,
          sender,
        },
        {
          amount: new anchor.BN(sendAmount.toString()),
          recipientChain,
          recipient,
          nonce,
        }
      );
      await expectIxFail([ix], [commonTokenOwner], "ZeroRecipient");
    });

    it("cannot send tbtc to gateway (gateway is zero address)", async () => {
      // Use common token account.
      const sender = commonTokenOwner.publicKey;
      const senderToken = getAssociatedTokenAddressSync(
        tbtc.getMintPDA(),
        sender
      );

      // Clear the destination gateway address, as done when deprecating a route.
      const recipientChain = 5;
      const clearGatewayIx = await wormholeGateway.updateGatewayAddress(
        {
          authority: authority.publicKey,
        },
        { chain: recipientChain, address: Array.from(Buffer.alloc(32)) }
      );
      await expectIxSuccess([clearGatewayIx], [authority]);

      const recipient = Array.from(Buffer.alloc(32, "deadbeef", "hex"));
      const nonce = 420;

      const sendAmount = BigInt(69);
      const ix = await wormholeGateway.sendTbtcGatewayIx(
        {
          senderToken,
          sender,
        },
        {
          amount: new anchor.BN(sendAmount.toString()),
          recipientChain,
          recipient,
          nonce,
        }
      );
      await expectIxFail([ix], [commonTokenOwner], "ZeroGateway");
    });

    it("cannot send tbtc to gateway (gateway is disabled)", async () => {
      // Use common token account.
      const sender = commonTokenOwner.publicKey;
      const senderToken = getAssociatedTokenAddressSync(
        tbtc.getMintPDA(),
        sender
      );

      // Disable the destination gateway address, as done when deprecating a route.
      const recipientChain = 5;
      const disableGatewayIx = await wormholeGateway.updateGatewayAddress(
        {
          authority: authority.publicKey,
        },
        { chain: recipientChain, address: DISABLED_GATEWAY_ADDRESS }
      );
      await expectIxSuccess([disableGatewayIx], [authority]);

      const recipient = Array.from(Buffer.alloc(32, "deadbeef", "hex"));
      const nonce = 420;

      const sendAmount = BigInt(69);
      const ix = await wormholeGateway.sendTbtcGatewayIx(
        {
          senderToken,
          sender,
        },
        {
          amount: new anchor.BN(sendAmount.toString()),
          recipientChain,
          recipient,
          nonce,
        }
      );
      await expectIxFail([ix], [commonTokenOwner], "GatewayDisabled");
    });

    it("cannot send tbtc to gateway (invalid target gateway)", async () => {
      // Use common token account.
      const sender = commonTokenOwner.publicKey;
      const senderToken = getAssociatedTokenAddressSync(
        tbtc.getMintPDA(),
        sender
      );

      // Get destination gateway.
      const recipientChain = 69; // bad gateway
      const recipient = Array.from(Buffer.alloc(32)); // empty buffer
      const nonce = 420;

      const sendAmount = BigInt(69);
      const ix = await wormholeGateway.sendTbtcGatewayIx(
        {
          senderToken,
          sender,
        },
        {
          amount: new anchor.BN(sendAmount.toString()),
          recipientChain,
          recipient,
          nonce,
        }
      );
      await expectIxFail([ix], [commonTokenOwner], "AccountNotInitialized");
    });
  });

  describe("send wrapped tbtc", () => {
    it("send wrapped tbtc", async () => {
      // Use common token account.
      const sender = commonTokenOwner.publicKey;
      const senderToken = getAssociatedTokenAddressSync(
        tbtc.getMintPDA(),
        sender
      );

      // Check token accounts.
      const [senderTbtcBefore, gatewayBefore] = await Promise.all([
        getAccount(connection, senderToken),
        getAccount(connection, gatewayWrappedTbtcToken),
      ]);

      // Check minted amount before.
      const mintedAmountBefore = await wormholeGateway.getMintedAmount();

      // Send to a gateway-less destination chain. Chain 69 has no registered
      // tBTC gateway, so its GatewayInfo PDA is uninitialized. The helper still
      // passes the canonical (uninitialized) PDA - the account is mandatory and
      // seeds-pinned - and the program treats an uninitialized gateway_info as
      // "no gateway", so the wrapped send must still succeed. This is the
      // regression guard for the gateway-less wrapped-transfer path.
      const recipientChain = 69;

      const recipient = Array.from(Buffer.alloc(32, "deadbeef", "hex"));
      const nonce = 420;

      // This should work.
      const sendAmount = BigInt(2000);
      const ix = await wormholeGateway.sendTbtcWrappedIx(
        {
          senderToken,
          sender,
        },
        {
          amount: new anchor.BN(sendAmount.toString()),
          recipientChain,
          recipient,
          arbiterFee: new anchor.BN(0),
          nonce,
        }
      );
      await expectIxSuccess([ix], [commonTokenOwner]);

      // Check token accounts after sending tbtc.
      const [senderTbtcAfter, gatewayAfter] = await Promise.all([
        getAccount(connection, senderToken),
        getAccount(connection, gatewayWrappedTbtcToken),
      ]);

      // Check minted amount.
      const mintedAmountAfter = await wormholeGateway.getMintedAmount();
      expect(mintedAmountAfter).to.equal(mintedAmountBefore - sendAmount);

      // Check balance change.
      expect(senderTbtcAfter.amount).to.equal(
        senderTbtcBefore.amount - sendAmount
      );
      expect(gatewayAfter.amount).to.equal(gatewayBefore.amount - sendAmount);
    });

    it("cannot send wrapped tbtc (insufficient wrapped balance)", async () => {
      // Use common token account.
      const sender = commonTokenOwner.publicKey;
      const senderToken = getAssociatedTokenAddressSync(
        tbtc.getMintPDA(),
        sender
      );

      // Get destination gateway.
      const recipientChain = 2;
      const recipient = Array.from(Buffer.alloc(32, "deadbeef", "hex"));
      const nonce = 420;

      // Check token accounts.
      const gatewayWrappedBalance = await getAccount(
        connection,
        gatewayWrappedTbtcToken
      );

      // Try an amount that won't work.
      const sendAmount = gatewayWrappedBalance.amount + BigInt(69);
      const ix = await wormholeGateway.sendTbtcWrappedIx(
        {
          senderToken,
          sender,
        },
        {
          amount: new anchor.BN(sendAmount.toString()),
          recipientChain,
          recipient,
          arbiterFee: new anchor.BN(0),
          nonce,
        }
      );
      await expectIxFail([ix], [commonTokenOwner], "NotEnoughWrappedTbtc");
    });

    it("cannot send wrapped tbtc(zero amount)", async () => {
      // Use common token account.
      const sender = commonTokenOwner.publicKey;
      const senderToken = getAssociatedTokenAddressSync(
        tbtc.getMintPDA(),
        sender
      );

      // Get destination gateway.
      const recipientChain = 2;
      const recipient = Array.from(Buffer.alloc(32, "deadbeef", "hex"));
      const nonce = 420;

      // Try an amount that won't work.
      const sendAmount = BigInt(0);
      const ix = await wormholeGateway.sendTbtcWrappedIx(
        {
          senderToken,
          sender,
        },
        {
          amount: new anchor.BN(sendAmount.toString()),
          recipientChain,
          recipient,
          arbiterFee: new anchor.BN(0),
          nonce,
        }
      );
      await expectIxFail([ix], [commonTokenOwner], "ZeroAmount");
    });

    it("cannot send wrapped tbtc (recipient is zero address)", async () => {
      // Use common token account.
      const sender = commonTokenOwner.publicKey;
      const senderToken = getAssociatedTokenAddressSync(
        tbtc.getMintPDA(),
        sender
      );

      // Get destination gateway.
      const recipientChain = 2;
      const recipient = Array.from(Buffer.alloc(32)); // empty buffer
      const nonce = 420;

      const sendAmount = BigInt(69);
      const ix = await wormholeGateway.sendTbtcWrappedIx(
        {
          senderToken,
          sender,
        },
        {
          amount: new anchor.BN(sendAmount.toString()),
          recipientChain,
          recipient,
          arbiterFee: new anchor.BN(0),
          nonce,
        }
      );
      await expectIxFail([ix], [commonTokenOwner], "ZeroRecipient");
    });

    it("cannot send wrapped tbtc when route is disabled", async () => {
      // Use common token account.
      const sender = commonTokenOwner.publicKey;
      const senderToken = getAssociatedTokenAddressSync(
        tbtc.getMintPDA(),
        sender
      );

      const recipientChain = 5;
      const disableGatewayIx = await wormholeGateway.updateGatewayAddress(
        {
          authority: authority.publicKey,
        },
        { chain: recipientChain, address: DISABLED_GATEWAY_ADDRESS }
      );
      await expectIxSuccess([disableGatewayIx], [authority]);

      const recipient = Array.from(Buffer.alloc(32, "deadbeef", "hex"));
      const nonce = 420;

      const sendAmount = BigInt(69);
      const ix = await wormholeGateway.sendTbtcWrappedIx(
        {
          senderToken,
          sender,
        },
        {
          amount: new anchor.BN(sendAmount.toString()),
          recipientChain,
          recipient,
          arbiterFee: new anchor.BN(0),
          nonce,
        }
      );
      await expectIxFail([ix], [commonTokenOwner], "GatewayDisabled");
    });

    it("cannot bypass a disabled route by substituting the gateway_info account", async () => {
      // Use common token account.
      const sender = commonTokenOwner.publicKey;
      const senderToken = getAssociatedTokenAddressSync(
        tbtc.getMintPDA(),
        sender
      );

      // Disable the destination gateway (idempotent).
      const recipientChain = 5;
      const disableGatewayIx = await wormholeGateway.updateGatewayAddress(
        {
          authority: authority.publicKey,
        },
        { chain: recipientChain, address: DISABLED_GATEWAY_ADDRESS }
      );
      await expectIxSuccess([disableGatewayIx], [authority]);

      const recipient = Array.from(Buffer.alloc(32, "deadbeef", "hex"));
      const nonce = 420;

      // Attempt to dodge the disabled-gateway check by passing a substitute
      // account instead of the canonical gateway_info PDA for the chain. The
      // seeds constraint must reject it, so a disabled route cannot be bypassed.
      const bogusGatewayInfo = anchor.web3.Keypair.generate().publicKey;

      const sendAmount = BigInt(69);
      const ix = await wormholeGateway.sendTbtcWrappedIx(
        {
          senderToken,
          sender,
          gatewayInfo: bogusGatewayInfo,
        },
        {
          amount: new anchor.BN(sendAmount.toString()),
          recipientChain,
          recipient,
          arbiterFee: new anchor.BN(0),
          nonce,
        }
      );
      await expectIxFail([ix], [commonTokenOwner], "ConstraintSeeds");
    });
  });
});
