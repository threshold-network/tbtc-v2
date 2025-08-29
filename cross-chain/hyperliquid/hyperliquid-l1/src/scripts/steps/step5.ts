import { Hyperliquid } from '../../hyperliquid-ts';
import { USDC_SPOT_INDEX } from '../../hyperliquid-ts/types/constants';
import type { SpotTokens } from '../../hyperliquid-ts/types'; // (Optional) for type-safety

import dotenv from 'dotenv';
dotenv.config();

export default async function step5() {
  console.log('Running Step 5...');

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

  const spotTokens: SpotTokens = {
    tokens: [tokenSpotIndex, USDC_SPOT_INDEX],
  };

  try {
    const result = await sdk.exchange.registerSpot(spotTokens);

    console.log('Spot tokens registration result:', result);
  } catch (error) {
    console.error('Error registering token:', error);
  }
}
