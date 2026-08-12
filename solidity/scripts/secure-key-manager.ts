/**
 * Simplified Secure Private Key Manager for Deployment
 *
 * This is a simplified version that only provides the functionality needed
 * for deployment scripts, avoiding cross-package dependencies.
 */

import * as fs from "fs"
import * as path from "path"
import { decryptPrivateKey } from "./private-key-crypto"

const ENCRYPTED_KEY_FILE = path.join(__dirname, ".encrypted-key")

export interface SecureKeyManager {
  getDecryptedKey(): Promise<string>
  hasEncryptedKey(): boolean
}

class SecureKeyManagerImpl implements SecureKeyManager {
  /**
   * Get decrypted private key (simplified version for deployment)
   */
  async getDecryptedKey(): Promise<string> {
    if (!this.hasEncryptedKey()) {
      throw new Error(
        "No encrypted key found. Please set up encrypted key first."
      )
    }

    // For deployment, we'll use environment variable as fallback
    const masterPassword = process.env.DEPLOYER_PASSWORD
    if (!masterPassword) {
      throw new Error("DEPLOYER_PASSWORD environment variable not set")
    }

    const encryptedData = fs.readFileSync(ENCRYPTED_KEY_FILE, "utf8")

    try {
      // `await` is required here: without it, a decryptPrivateKey rejection
      // would bypass the catch below instead of being caught by it.
      return await decryptPrivateKey(encryptedData, masterPassword)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Failed to decrypt private key. Check your password. (${reason})`
      )
    }
  }

  /**
   * Check if encrypted key exists
   */
  // eslint-disable-next-line class-methods-use-this
  hasEncryptedKey(): boolean {
    return fs.existsSync(ENCRYPTED_KEY_FILE)
  }
}

export const secureKeyManager = new SecureKeyManagerImpl()
