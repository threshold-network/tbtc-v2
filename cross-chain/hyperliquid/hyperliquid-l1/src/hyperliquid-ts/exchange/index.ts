import { ethers } from 'ethers';
import { RateLimiter } from '../utils/rateLimiter';
import { HttpApi } from '../utils/helpers';
import { signL1Action } from '../utils/signing';
import * as CONSTANTS from '../types/constants';

import {
  RegisterToken,
  UserGenesis,
  Genesis,
  SpotTokens,
  Hyperliquidity,
  DeployerTradingFeeShare
} from '../types/index';

import { ExchangeType, ENDPOINTS } from '../types/constants';
import { Hyperliquid } from '..';

export class ExchangeAPI {
  private wallet: ethers.Wallet;
  private httpApi: HttpApi;
  private IS_MAINNET = true;
  private parent: Hyperliquid;

  constructor(
    testnet: boolean,
    privateKey: string,
    rateLimiter: RateLimiter,
    parent: Hyperliquid,
  ) {
    const baseURL = testnet ? CONSTANTS.BASE_URLS.TESTNET : CONSTANTS.BASE_URLS.PRODUCTION;
    this.IS_MAINNET = !testnet;
    this.httpApi = new HttpApi(baseURL, ENDPOINTS.EXCHANGE, rateLimiter);
    this.wallet = new ethers.Wallet(privateKey);
    this.parent = parent;
  }

  async registerToken(token: RegisterToken): Promise<any> {
    await this.parent.ensureInitialized();
    try {
      const action = {
        type: ExchangeType.SPOT_DEPLOY,
        registerToken2: token
      };

      const nonce = Date.now();
      const signature = await signL1Action(this.wallet, action, null, nonce, this.IS_MAINNET);

      const payload = { action, nonce, signature, vaultAddress: null };
      return this.httpApi.makeRequest(payload, 1);
    } catch (error) {
      throw error;
    }
  }

  async registerDeployerTradingFeeShare(deployerTradingFeeShare: DeployerTradingFeeShare): Promise<any> {
    await this.parent.ensureInitialized();
    try {
      const action = {
        type: ExchangeType.SPOT_DEPLOY,
        setDeployerTradingFeeShare: deployerTradingFeeShare
      };

      const nonce = Date.now();
      const signature = await signL1Action(this.wallet, action, null, nonce, this.IS_MAINNET);

      const payload = { action, nonce, signature, vaultAddress: null };
      return this.httpApi.makeRequest(payload, 1);
    } catch (error) {
      throw error;
    }
  }

  async registerUserGenesis(userGenesis: UserGenesis): Promise<any> {
    await this.parent.ensureInitialized();
    try {
      const action = {
        type: ExchangeType.SPOT_DEPLOY,
        userGenesis
      };

      const nonce = Date.now();
      const signature = await signL1Action(this.wallet, action, null, nonce, this.IS_MAINNET);

      const payload = { action, nonce, signature, vaultAddress: null };
      return this.httpApi.makeRequest(payload, 1);
    } catch (error) {
      throw error;
    }
  }

  async registerGenesis(genesis: Genesis): Promise<any> {
    await this.parent.ensureInitialized();
    try {
      const action = {
        type: ExchangeType.SPOT_DEPLOY,
        genesis
      };

      const nonce = Date.now();
      const signature = await signL1Action(this.wallet, action, null, nonce, this.IS_MAINNET);

      const payload = { action, nonce, signature, vaultAddress: null };
      return this.httpApi.makeRequest(payload, 1);
    } catch (error) {
      throw error;
    }
  }

  async registerSpot(spotTokens: SpotTokens): Promise<any> {
    await this.parent.ensureInitialized();
    try {
      const action = {
        type: ExchangeType.SPOT_DEPLOY,
        registerSpot: spotTokens
      };

      const nonce = Date.now();
      const signature = await signL1Action(this.wallet, action, null, nonce, this.IS_MAINNET);

      const payload = { action, nonce, signature, vaultAddress: null };
      return this.httpApi.makeRequest(payload, 1);
    } catch (error) {
      throw error;
    } 
  }

  async registerHyperliquidity(hyperliquidity: Hyperliquidity): Promise<any> {
    await this.parent.ensureInitialized();
    try {
      const action = {
        type: ExchangeType.SPOT_DEPLOY,
        registerHyperliquidity: hyperliquidity
      };

      const nonce = Date.now();
      const signature = await signL1Action(this.wallet, action, null, nonce, this.IS_MAINNET);

      const payload = { action, nonce, signature, vaultAddress: null };
      return this.httpApi.makeRequest(payload, 1);
    } catch (error) {
      throw error;
    }
  }
}
