/**
 * Secure storage for sensitive values using Electron's safeStorage API.
 * Falls back to plaintext if safeStorage is unavailable (e.g., Linux without keyring).
 *
 * Encrypted values are stored as base64 strings prefixed with "enc:" in data.json.
 * Plaintext values (legacy or fallback) have no prefix.
 */

let safeStorage: any = null;

try {
  const electron = require("electron");
  if (electron?.remote?.safeStorage) {
    safeStorage = electron.remote.safeStorage;
  } else if (electron?.safeStorage) {
    safeStorage = electron.safeStorage;
  }
} catch {
  // Not in Electron or safeStorage unavailable
}

const ENCRYPTED_PREFIX = "enc:";

/**
 * Encrypt a value for storage. Returns a prefixed base64 string.
 * Falls back to plaintext if encryption unavailable.
 */
export function encrypt(value: string): string {
  if (!value) return "";

  if (safeStorage?.isEncryptionAvailable?.()) {
    try {
      const buffer = safeStorage.encryptString(value);
      return ENCRYPTED_PREFIX + buffer.toString("base64");
    } catch {
      // Encryption failed — store as plaintext
      return value;
    }
  }

  return value;
}

/**
 * Decrypt a stored value. Detects encrypted vs plaintext automatically.
 */
export function decrypt(stored: string): string {
  if (!stored) return "";

  if (stored.startsWith(ENCRYPTED_PREFIX)) {
    if (safeStorage?.isEncryptionAvailable?.()) {
      try {
        const buffer = Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), "base64");
        return safeStorage.decryptString(buffer);
      } catch {
        // Decryption failed — value may be corrupted
        return "";
      }
    }
    // Can't decrypt without safeStorage — return empty
    return "";
  }

  // No prefix — plaintext (legacy or fallback)
  return stored;
}

/**
 * Check if secure storage is available.
 */
export function isSecureStorageAvailable(): boolean {
  return safeStorage?.isEncryptionAvailable?.() ?? false;
}
