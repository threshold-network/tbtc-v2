import { Hyperliquid } from '../../hyperliquid-ts';
import { SYSTEM_CONTRACT, TBTC_MAX_SUPPLY_IN_WEI } from '../../hyperliquid-ts/types/constants';
import type { UserGenesis } from '../../hyperliquid-ts/types'; // (Optional) for type-safety

import dotenv from 'dotenv';
dotenv.config();

export default async function step3() {
  console.log('Running Step 3...');

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

  const userGenesis: UserGenesis = {
    token: tokenSpotIndex,
    userAndWei: [[SYSTEM_CONTRACT, TBTC_MAX_SUPPLY_IN_WEI]],
    existingTokenAndWei: [],
  };

  try {
    const result = await sdk.exchange.registerUserGenesis(userGenesis);

    console.log('User genesis registration result:', result);
  } catch (error) {
    console.error('Error registering token:', error);
  }
}
