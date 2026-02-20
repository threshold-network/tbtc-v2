import { Hyperliquid } from '../../hyperliquid-ts';
import { TBTC_MAX_SUPPLY_IN_WEI } from '../../hyperliquid-ts/types/constants';
import type { Genesis } from '../../hyperliquid-ts/types'; // (Optional) for type-safety

import dotenv from 'dotenv';
dotenv.config();

export default async function step4() {
  console.log('Running Step 4...');

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

  const genesis: Genesis = {
    token: tokenSpotIndex,
    maxSupply: TBTC_MAX_SUPPLY_IN_WEI,
  };

  try {
    const result = await sdk.exchange.registerGenesis(genesis);

    console.log('Genesis registration result:', result);
  } catch (error) {
    console.error('Error registering token:', error);
  }
}
