import CryptoJS from 'crypto-js';

/**
 * Encryption service for securing sensitive user data
 */
export class EncryptionService {
  constructor(secretKey) {
    if (!secretKey) {
      throw new Error('Encryption key is required');
    }
    this.secretKey = secretKey;
  }

  /**
   * Encrypt data using AES-256
   * @param {string} plainText - Text to encrypt
   * @returns {string} Encrypted text
   */
  encrypt(plainText) {
    if (!plainText) return null;
    return CryptoJS.AES.encrypt(plainText, this.secretKey).toString();
  }

  /**
   * Decrypt AES-256 encrypted data
   * @param {string} encryptedText - Encrypted text
   * @returns {string} Decrypted plain text
   */
  decrypt(encryptedText) {
    if (!encryptedText) return null;
    const bytes = CryptoJS.AES.decrypt(encryptedText, this.secretKey);
    return bytes.toString(CryptoJS.enc.Utf8);
  }

  /**
   * Hash data using SHA-256 (one-way)
   * @param {string} data - Data to hash
   * @returns {string} Hash
   */
  hash(data) {
    return CryptoJS.SHA256(data).toString();
  }
}
