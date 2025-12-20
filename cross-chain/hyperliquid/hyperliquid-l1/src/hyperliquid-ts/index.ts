import { ExchangeAPI } from './exchange';
import { RateLimiter } from './utils/rateLimiter';
import { ethers } from 'ethers';
import { AuthenticationError } from './utils/errors';
import { InfoAPI } from './info';

export interface HyperliquidConfig {
  privateKey?: string;
  testnet?: boolean;
}

export class Hyperliquid {
  public exchange: ExchangeAPI;
  public info: InfoAPI;

  private rateLimiter: RateLimiter;
  private isValidPrivateKey: boolean = false;
  private _initialized: boolean = false;
  private _initializing: Promise<void> | null = null;

  constructor(params: HyperliquidConfig = {}) {
    const { privateKey, testnet = false } = params;
    this.rateLimiter = new RateLimiter();

    // Initialize info API
    this.info = new InfoAPI(testnet, this.rateLimiter);

    // Create proxy objects for exchange
    this.exchange = this.createAuthenticatedProxy(ExchangeAPI);

    if (privateKey) {
      this.initializePrivateKey(privateKey, testnet);
    }
  }

  public async connect(): Promise<void> {
    if (!this._initialized) {
      if (!this._initializing) {
        this._initializing = this.initialize();
      }
      await this._initializing;
    }
  }

  private async initialize(): Promise<void> {
    if (this._initialized) return;

    try {
      this._initialized = true;
      this._initializing = null;
    } catch (error) {
      this._initializing = null;
      throw error;
    }
  }

  public async ensureInitialized(): Promise<void> {
    await this.connect();
  }

  private initializePrivateKey(privateKey: string, testnet: boolean): void {
    try {
      const formattedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;

      new ethers.Wallet(formattedPrivateKey); // Validate the private key
      this.exchange = new ExchangeAPI(
        testnet,
        formattedPrivateKey,
        this.rateLimiter,
        this,
      );

      this.isValidPrivateKey = true;
    } catch (error) {
      console.warn("Invalid private key provided. Some functionalities will be limited.");
      this.isValidPrivateKey = false;
    }
  }

  private createAuthenticatedProxy<T extends object>(Class: new (...args: any[]) => T): T {
    return new Proxy({} as T, {
      get: (target, prop) => {
        if (!this.isValidPrivateKey) {
          throw new AuthenticationError('Invalid or missing private key. This method requires authentication.');
        }
        return target[prop as keyof T];
      }
    });
  }

  // Modify existing methods to check initialization
  public isAuthenticated(): boolean {
    this.ensureInitialized();
    return this.isValidPrivateKey;
  }
}

export * from './types';
export * from './utils/signing';
