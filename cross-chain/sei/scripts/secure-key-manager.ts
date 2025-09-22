/**
 * Secure Private Key Manager for Sei Deployment
 * 
 * This script helps encrypt and decrypt private keys securely.
 * Private keys are encrypted on disk and only decrypted on-demand.
 */

import fs from 'fs';
import path from 'path';
import CryptoJS from 'crypto-js';
import { input, password, confirm } from '@inquirer/prompts';

const ENCRYPTED_KEY_FILE = path.join(__dirname, '..', '.encrypted-key');

export interface SecureKeyManager {
  encryptAndStoreKey(): Promise<void>;
  getDecryptedKey(): Promise<string>;
  hasEncryptedKey(): boolean;
  removeEncryptedKey(): void;
}

class SecureKeyManagerImpl implements SecureKeyManager {
  
  /**
   * Encrypt a private key and store it securely
   */
  async encryptAndStoreKey(): Promise<void> {
    console.log('🔐 Setting up encrypted private key storage...');
    
    const privateKey = await password({
      message: 'Enter your private key (will be encrypted):',
      mask: '*',
      validate: (input: string) => {
        if (!input || input.length !== 64) {
          return 'Private key must be 64 characters long (without 0x prefix)';
        }
        return true;
      }
    });

    const masterPassword = await password({
      message: 'Create a master password to encrypt your key:',
      mask: '*',
      validate: (input: string) => {
        if (input.length < 8) {
          return 'Master password must be at least 8 characters';
        }
        return true;
      }
    });

    const confirmPassword = await password({
      message: 'Confirm master password:',
      mask: '*',
      validate: (input: string) => {
        if (input !== masterPassword) {
          return 'Passwords do not match';
        }
        return true;
      }
    });

    // Encrypt the private key
    const encrypted = CryptoJS.AES.encrypt(privateKey, masterPassword).toString();
    
    // Store encrypted key
    fs.writeFileSync(ENCRYPTED_KEY_FILE, encrypted, { mode: 0o600 });
    
    console.log('✅ Private key encrypted and stored securely');
    console.log(`📁 Encrypted file: ${ENCRYPTED_KEY_FILE}`);
    console.log('⚠️  Remember your master password - it cannot be recovered!');
  }

  /**
   * Decrypt and return the private key on-demand
   */
  async getDecryptedKey(): Promise<string> {
    if (!this.hasEncryptedKey()) {
      throw new Error('No encrypted key found. Run encryption setup first.');
    }

    const masterPassword = await password({
      message: 'Enter master password to decrypt private key:',
      mask: '*'
    });

    try {
      const encryptedData = fs.readFileSync(ENCRYPTED_KEY_FILE, 'utf8');
      const decrypted = CryptoJS.AES.decrypt(encryptedData, masterPassword);
      const privateKey = decrypted.toString(CryptoJS.enc.Utf8);
      
      if (!privateKey || privateKey.length !== 64) {
        throw new Error('Invalid password or corrupted key file');
      }
      
      return privateKey;
    } catch (error) {
      throw new Error('Failed to decrypt private key. Check your password.');
    }
  }

  /**
   * Check if encrypted key exists
   */
  hasEncryptedKey(): boolean {
    return fs.existsSync(ENCRYPTED_KEY_FILE);
  }

  /**
   * Remove encrypted key file
   */
  removeEncryptedKey(): void {
    if (fs.existsSync(ENCRYPTED_KEY_FILE)) {
      fs.unlinkSync(ENCRYPTED_KEY_FILE);
      console.log('🗑️  Encrypted key file removed');
    }
  }
}

// CLI interface
async function main() {
  const keyManager = new SecureKeyManagerImpl();
  
  if (process.argv.includes('--encrypt')) {
    await keyManager.encryptAndStoreKey();
  } else if (process.argv.includes('--decrypt')) {
    try {
      const key = await keyManager.getDecryptedKey();
      console.log('🔓 Private key decrypted successfully');
      // Don't log the actual key for security
    } catch (error: any) {
      console.error('❌ Decryption failed:', error.message);
      process.exit(1);
    }
  } else if (process.argv.includes('--remove')) {
    keyManager.removeEncryptedKey();
  } else {
    console.log('Usage:');
    console.log('  --encrypt  : Encrypt and store private key');
    console.log('  --decrypt  : Test decryption');
    console.log('  --remove   : Remove encrypted key file');
  }
}

// Export the class for use in other scripts
export const secureKeyManager = new SecureKeyManagerImpl();

// Run CLI if called directly
if (require.main === module) {
  main().catch(console.error);
}