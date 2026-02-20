import { HttpApi } from '../utils/helpers';
import * as CONSTANTS from '../types/constants';
import { RateLimiter } from '../utils/rateLimiter';
import { convertResponse } from '../utils/symbolConversion';

export class InfoAPI {
  private httpApi: HttpApi;

  constructor(testnet: boolean, rateLimiter: RateLimiter) {
    const baseURL = testnet ? CONSTANTS.BASE_URLS.TESTNET : CONSTANTS.BASE_URLS.PRODUCTION;
    this.httpApi = new HttpApi(baseURL, CONSTANTS.ENDPOINTS.INFO, rateLimiter);
  }

  async getSpotDeployState(user: string, rawResponse: boolean = false): Promise<any> {
    const response = await this.httpApi.makeRequest({
      type: CONSTANTS.InfoType.SPOT_DEPLOY_STATE,
      user: user
    }, 20);

    return rawResponse ? response : await convertResponse(response);
  }
}
