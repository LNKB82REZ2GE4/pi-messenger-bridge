import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { MsgBridgeConfig } from "./types.js";

export function getBridgeConfigPath(): string {
  const piConfigDir = process.env.PI_CODING_AGENT_DIR;
  if (piConfigDir && piConfigDir.trim()) {
    return path.join(piConfigDir, "msg-bridge.json");
  }
  return path.join(os.homedir(), ".pi", "msg-bridge.json");
}

function getConfigDir(): string {
  return path.dirname(getBridgeConfigPath());
}

/**
 * Load config from file and env vars (env vars override file).
 */
export function loadConfig(): MsgBridgeConfig {
  const config: MsgBridgeConfig = {};

  const configPath = getBridgeConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      const stats = fs.statSync(configPath);
      const mode = stats.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        console.warn(`⚠️  Config file ${configPath} has insecure permissions (${mode.toString(8)}). Should be 0600.`);
      }

      const fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      Object.assign(config, fileConfig);
    } catch (err) {
      console.error("Failed to load config file:", err);
    }
  }

  // Environment variables override file config (higher priority)
  if (process.env.PI_TELEGRAM_TOKEN) {
    config.telegram = { token: process.env.PI_TELEGRAM_TOKEN };
  }
  if (process.env.PI_WHATSAPP_AUTH_PATH) {
    config.whatsapp = { authPath: process.env.PI_WHATSAPP_AUTH_PATH };
  }
  if (process.env.PI_SLACK_BOT_TOKEN && process.env.PI_SLACK_APP_TOKEN) {
    config.slack = {
      botToken: process.env.PI_SLACK_BOT_TOKEN,
      appToken: process.env.PI_SLACK_APP_TOKEN,
    };
  }
  if (process.env.PI_DISCORD_TOKEN) {
    config.discord = { token: process.env.PI_DISCORD_TOKEN };
  }

  return config;
}

/**
 * Save config to file with secure permissions.
 */
export function saveConfig(config: MsgBridgeConfig): void {
  const configPath = getBridgeConfigPath();
  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(configDir, 0o700);
  } catch (err) {
    console.warn("Failed to set directory permissions:", err);
  }
}
