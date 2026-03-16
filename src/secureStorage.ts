/**
 * Secure storage for sensitive values using Electron's safeStorage API.
 * Falls back to plaintext if safeStorage is unavailable (e.g., Linux without keyring).
 *
 * Encrypted values are stored as base64 strings prefixed with "enc:" in data.json.
 * Plaintext values (legacy or fallback) have no prefix.
 */

interface SafeStorage {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (buffer: Buffer) => string;
}

let safeStorage: SafeStorage | null = null;

try {
  // electron is declared as external in the build config — dynamic import
  // is not viable here because this must run synchronously at module load.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron: Record<string, unknown> = require("electron"); // skipcq: JS-0359
  const remote = electron.remote as Record<string, unknown> | undefined;
  if (remote?.safeStorage) {
    safeStorage = remote.safeStorage as SafeStorage;
  } else if (electron.safeStorage) {
    safeStorage = electron.safeStorage as SafeStorage;
  }
} catch { /* expected — not in Electron or safeStorage unavailable */ }

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
    } catch { /* expected — encryption failed, store as plaintext */
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
      } catch { /* expected — value may be corrupted */
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
