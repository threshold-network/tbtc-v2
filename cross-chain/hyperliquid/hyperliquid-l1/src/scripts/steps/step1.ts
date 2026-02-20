import { Hyperliquid } from '../../hyperliquid-ts';
import {
  TBTC_DEPLOYMENT_MAX_GAS,
  TBTC_FULL_NAME, TBTC_NAME,
  TBTC_SIZE_DECIMALS,
  TBTC_WEI_DECIMALS
} from '../../hyperliquid-ts/types/constants';
import type { RegisterToken } from '../../hyperliquid-ts/types'; // (Optional) for type-safety

import dotenv from 'dotenv';
dotenv.config();

export default async function step1() {
  console.log('Running Step 1...');

  // Read from environment variables or config
  const privateKey = process.env.private_key;
  const walletAddress = process.env.user_address;
  const testnet = true; // or false, depending on your environment

  const sdk = new Hyperliquid({
    privateKey,
    testnet,
  });

  await sdk.connect();

  const tokenToRegister: RegisterToken = {
    spec: {
      name: TBTC_NAME,
      szDecimals: TBTC_SIZE_DECIMALS,
      weiDecimals: TBTC_WEI_DECIMALS,
    },
    maxGas: TBTC_DEPLOYMENT_MAX_GAS,
    fullName: TBTC_FULL_NAME,
  };

  const spotDeploymentResult = await sdk.info.getSpotDeployState(walletAddress);
  console.log('Spot deployment result:', spotDeploymentResult.states[0].userGenesisBalances);

  try {
    const result = await sdk.exchange.registerToken(tokenToRegister);

    console.log('Token registration result:', result);
  } catch (error) {
    console.error('Error registering token:', error);
  }
}
