import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

const ADMIN_KEY_PATH = path.join(os.homedir(), ".pixa", "admin.key");

let cachedAdminKey: string | null = null;

/**
 * Returns the admin API key.
 * 1. Checks process.env.ADMIN_API_KEY (useful for debugging, overrides, or tests).
 * 2. Reads ~/.pixa/admin.key if it exists.
 * 3. Generates a secure random 32-byte key, saves it to ~/.pixa/admin.key, and returns it.
 */
export function getOrGenerateAdminKey(): string {
  if (cachedAdminKey) {
    return cachedAdminKey;
  }

  // Environment override takes priority if set
  if (process.env.ADMIN_API_KEY) {
    cachedAdminKey = process.env.ADMIN_API_KEY.trim();
    return cachedAdminKey;
  }

  try {
    if (fs.existsSync(ADMIN_KEY_PATH)) {
      const key = fs.readFileSync(ADMIN_KEY_PATH, "utf8").trim();
      if (key) {
        cachedAdminKey = key;
        return cachedAdminKey;
      }
    }
  } catch (err) {
    console.error(`[GATEWAY] Failed to read admin key from ${ADMIN_KEY_PATH}:`, err);
  }

  // Generate new key
  const newKey = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(ADMIN_KEY_PATH), { recursive: true });
    fs.writeFileSync(ADMIN_KEY_PATH, newKey, "utf8");
    console.log(`[GATEWAY] Auto-generated new admin key and saved to: ${ADMIN_KEY_PATH}`);
  } catch (err) {
    console.error(`[GATEWAY] Failed to write generated admin key to ${ADMIN_KEY_PATH}:`, err);
  }

  cachedAdminKey = newKey;
  return cachedAdminKey;
}

export function getAdminKeyPath(): string {
  return ADMIN_KEY_PATH;
}
