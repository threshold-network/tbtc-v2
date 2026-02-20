import { Hyperliquid, Hyperliquidity } from '../../hyperliquid-ts';

import dotenv from 'dotenv';
dotenv.config();

export default async function step6() {
  console.log('Running Step 6...');

  // Read from environment variables or config
  const privateKey = process.env.private_key;
  const walletAddress = process.env.user_address;
  const testnet = true; // or false, depending on your environment

  const sdk = new Hyperliquid({
    privateKey,
    testnet,
  });

  await sdk.connect();

  const deployState = await sdk.info.getSpotDeployState(walletAddress);
  const tokenSpotIndex = deployState.states[0].token;

  console.log('deployState:', deployState.states[0])

  const hyperliquidity: Hyperliquidity = {
    spot: tokenSpotIndex,
    startPx: "0",
    orderSz: "0",
    nOrders: 0, // zero because we don't want to deploy hyperliquidity
    nSeededLevels: 0,
  };

  try {
    const result = await sdk.exchange.registerHyperliquidity(hyperliquidity);

    console.log('Hyperliquidity registration result:', result);
  } catch (error) {
    console.error('Error registering token:', error);
  }
}
