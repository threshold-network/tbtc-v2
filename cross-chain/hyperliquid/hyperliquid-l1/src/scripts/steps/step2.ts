import { DeployerTradingFeeShare, Hyperliquid } from '../../hyperliquid-ts';

import dotenv from 'dotenv';
dotenv.config();

export default async function step2() {
  console.log('Running Step 2...');

  // Read from environment variables or config
  const privateKey = process.env.private_key;
  const walletAddress = process.env.user_address;
  const testnet = true; // or false, depending on your environment

  const sdk = new Hyperliquid({
    privateKey,
    testnet
  });

  await sdk.connect();

  const deployState = await sdk.info.getSpotDeployState(walletAddress);
  const tokenSpotIndex = deployState.states[0].token;

  const deployerTradingFeeShare: DeployerTradingFeeShare = {
    token: tokenSpotIndex,
    share: "0%",
  };

  try {
    const result = await sdk.exchange.registerDeployerTradingFeeShare(deployerTradingFeeShare);

    console.log('User genesis registration result:', result);
  } catch (error) {
    console.error('Error registering token:', error);
  }
}
