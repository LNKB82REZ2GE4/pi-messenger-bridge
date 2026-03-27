import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChallengeAuth } from "./auth/challenge-auth.js";
import { getBridgeConfigPath, loadConfig, saveConfig } from "./config.js";
import { extractTextFromMessage, formatToolCalls, hasToolCalls, splitMessage } from "./formatting.js";
import { acquireLock, releaseLock } from "./lock.js";
import { DiscordProvider } from "./transports/discord.js";
import { TransportManager } from "./transports/manager.js";
import { SlackProvider } from "./transports/slack.js";
import { TelegramProvider } from "./transports/telegram.js";
import { WhatsAppProvider } from "./transports/whatsapp.js";
import type { PendingRemoteChat, TransportStatus } from "./types.js";
import { openMainMenu } from "./ui/main-menu.js";
import { createStatusWidget } from "./ui/status-widget.js";

/**
 * pi-remote-pilot extension
 * Bridges messenger apps (Telegram, WhatsApp, Slack, Discord) into pi
 */
export default function (pi: ExtensionAPI): void {
  const transportManager = new TransportManager();
  const remoteTurnQueue: PendingRemoteChat[] = [];
  let activeRemoteChat: PendingRemoteChat | null = null;
  const consumedRequestIds = new Set<string>();
  let auth: ChallengeAuth;
  let ctx: ExtensionContext;

  const lockRootDir = path.join(os.homedir(), ".pi", "locks");
  const discordLockDir = path.join(lockRootDir, "msg-bridge-discord.lock");
  const discordLockOwnerFile = path.join(discordLockDir, "owner.json");
  let hasDiscordIntakeLock = false;
  let discordLockReason = "not-requested";

  function isProcessAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) {
      return false;
    }

    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      return err?.code === "EPERM";
    }
  }

  function releaseDiscordIntakeLock(): void {
    if (!hasDiscordIntakeLock) {
      return;
    }

    try {
      fs.rmSync(discordLockDir, { recursive: true, force: true });
    } catch (err) {
      console.warn("Failed to release Discord intake lock:", err);
    }

    hasDiscordIntakeLock = false;
    discordLockReason = "released";
  }

  function acquireDiscordIntakeLock(): { acquired: boolean; reason: string } {
    if (hasDiscordIntakeLock) {
      return { acquired: true, reason: "already-held" };
    }

    fs.mkdirSync(lockRootDir, { recursive: true, mode: 0o700 });

    const attemptAcquire = (): { acquired: boolean; reason: string } => {
      try {
        fs.mkdirSync(discordLockDir, { mode: 0o700 });
        const owner = {
          pid: process.pid,
          startedAt: Date.now(),
          hostname: os.hostname(),
        };
        fs.writeFileSync(discordLockOwnerFile, JSON.stringify(owner, null, 2), {
          mode: 0o600,
        });
        hasDiscordIntakeLock = true;
        discordLockReason = "acquired";
        return { acquired: true, reason: "acquired" };
      } catch (err: any) {
        if (err?.code !== "EEXIST") {
          return { acquired: false, reason: `lock-error:${err?.message ?? String(err)}` };
        }

        try {
          const ownerRaw = fs.readFileSync(discordLockOwnerFile, "utf8");
          const owner = JSON.parse(ownerRaw) as { pid?: number };
          const stale = !owner?.pid || !isProcessAlive(owner.pid);
          if (stale) {
            fs.rmSync(discordLockDir, { recursive: true, force: true });
            return attemptAcquire();
          }
          return { acquired: false, reason: `lock-held-by-pid:${owner.pid}` };
        } catch {
          return { acquired: false, reason: "lock-held" };
        }
      }
    };

    return attemptAcquire();
  }

  function ensureDiscordTransportRegistered(config: any): boolean {
    if (!config.discord?.token) {
      return false;
    }

    if (transportManager.getTransport("discord")) {
      return true;
    }

    const lockResult = acquireDiscordIntakeLock();
    if (!lockResult.acquired) {
      hasDiscordIntakeLock = false;
      discordLockReason = lockResult.reason;
      ctx.ui.notify(
        `Discord intake passive on this instance (${lockResult.reason}).`,
        "warning"
      );
      return false;
    }

    const discordProvider = new DiscordProvider(config.discord, auth);
    transportManager.addTransport(discordProvider);
    return true;
  }

  function isRemoteControlCommand(content: string): boolean {
    const trimmed = content.trim();
    return /^!(approve\s+\S+|deny(?:\s+\S+)?)$/i.test(trimmed);
  }

  /**
   * Update status widget
   */
  function updateWidget(): void {
    const config = loadConfig();

    if (config.showWidget === false) {
      ctx.ui.setWidget("msg-bridge-status", undefined);
      return;
    }

    const stats = auth.getStats();
    const transports: TransportStatus[] = transportManager
      .getStatus()
      .map((s) => ({
        type: s.type,
        connected: s.connected,
      }));

    const widget = createStatusWidget(transports, stats.usersByTransport);
    if (widget) {
      ctx.ui.setWidget("msg-bridge-status", [widget]);
    } else {
      ctx.ui.setWidget("msg-bridge-status", undefined);
    }
  }

  /**
   * Save auth state to config
   */
  function saveAuthState(): void {
    const config = loadConfig();
    config.auth = auth.exportConfig();
    saveConfig(config);
  }

  /**
   * Initialize extension
   */
  pi.on("session_start", async (_event, context) => {
    ctx = context;

    const config = loadConfig();

    auth = new ChallengeAuth(
      (code, username) => {
        ctx.ui.notify(
          `🔐 Challenge code for @${username}: ${code}`,
          "info"
        );
      },
      (message, level) => {
        ctx.ui.notify(message, level);
      },
      async (_chatId, _message) => {
        // Challenge notifications are sent via the transport's sendMessage
      },
      saveAuthState
    );

    if (config.auth) {
      auth.loadFromConfig(config.auth);
    }

    // Initialize transports in the background (non-blocking)
    (async () => {
      const transportPromises: Promise<void>[] = [];

      if (config.telegram?.token) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const telegramProvider = new TelegramProvider(config.telegram!.token, auth);
            transportManager.addTransport(telegramProvider);
          })
        );
      }

      if (config.whatsapp) {
        const bridgeConfigBase = path.dirname(getBridgeConfigPath());
        const whatsappAuthPath = config.whatsapp.authPath || path.join(
          bridgeConfigBase,
          "msg-bridge-whatsapp-auth"
        );

        const credsPath = path.join(whatsappAuthPath, "creds.json");
        if (fs.existsSync(credsPath)) {
          transportPromises.push(
            Promise.resolve().then(() => {
              const whatsappConfig = {
                ...config.whatsapp!,
                debug: config.debug,
                onStatus: (message: string, level: "info" | "warning" | "error" = "info") => {
                  ctx.ui.notify(message, level);
                },
              };
              const whatsappProvider = new WhatsAppProvider(whatsappConfig, auth);
              transportManager.addTransport(whatsappProvider);
            })
          );
        } else {
          delete config.whatsapp;
          saveConfig(config);
        }
      }

      if (config.slack?.botToken && config.slack?.appToken) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const slackProvider = new SlackProvider(config.slack!, auth);
            transportManager.addTransport(slackProvider);
          })
        );
      }

      // Auto-add Discord if configured (singleton lock enforced)
      if (config.discord?.token) {
        transportPromises.push(
          Promise.resolve().then(() => {
            ensureDiscordTransportRegistered(config);
          })
        );
      }

      await Promise.all(transportPromises);

      // Auto-connect if configured
      const transports = transportManager.getAllTransports();
      if (transports.length > 0 && config.autoConnect !== false) {
        if (!acquireLock()) {
          ctx.ui.notify("ℹ️ msg-bridge: another instance is already connected — skipping auto-connect", "info");
        } else {
          try {
            await transportManager.connectAll();
            updateWidget();
          } catch (err) {
            releaseLock();
            ctx.ui.notify(`⚠️ Some transports failed to connect: ${(err as Error).message}`, "warning");
          }
        }
      }
    })().catch(err => {
      console.error("Transport initialization error:", err);
      ctx.ui.notify(`❌ Transport initialization failed: ${err.message}`, "error");
    });

    transportManager.onMessage((msg) => {
      const requestId = `${msg.transport}:${msg.messageId}`;
      const isControl = isRemoteControlCommand(msg.content);

      pi.events.emit("msg-bridge:incoming", {
        ...msg,
        requestId,
        queueDepth: remoteTurnQueue.length + (isControl ? 0 : 1),
        isControl,
      });

      if (isControl) {
        return;
      }

      // Defer queue/enqueue one tick so programmatic handlers can consume
      // the request without triggering an LLM turn.
      setTimeout(() => {
        if (consumedRequestIds.has(requestId)) {
          consumedRequestIds.delete(requestId);
          return;
        }

        remoteTurnQueue.push({
          chatId: msg.chatId,
          transport: msg.transport,
          username: msg.username,
          messageId: msg.messageId,
          requestId,
          queuedAt: Date.now(),
        });

        const taggedMessage = `[📱 @${msg.username} via ${msg.transport} req:${requestId}]: ${msg.content}`;
        pi.sendUserMessage(taggedMessage);
      }, 0);
    });

    transportManager.onError((err, transport) => {
      ctx.ui.notify(`❌ ${transport} error: ${err.message}`, "error");
    });

    pi.events.on("msg-bridge:consume-request", (data) => {
      const payload = data as { requestId?: string };
      if (!payload.requestId) return;
      consumedRequestIds.add(payload.requestId);
    });

    pi.events.on("msg-bridge:enqueue-request", (data) => {
      const payload = data as {
        transport?: string;
        chatId?: string;
        username?: string;
        messageId?: string;
        requestId?: string;
        queuedAt?: number;
        synthetic?: boolean;
      };

      if (!payload.transport || !payload.chatId || !payload.requestId) {
        return;
      }

      remoteTurnQueue.push({
        chatId: payload.chatId,
        transport: payload.transport,
        username: payload.username ?? "remote-user",
        messageId: payload.messageId ?? payload.requestId,
        requestId: payload.requestId,
        queuedAt: payload.queuedAt ?? Date.now(),
        synthetic: payload.synthetic ?? true,
      });
    });

    pi.events.on("msg-bridge:discord-create-channel", async (data) => {
      const payload = data as {
        guildId?: string;
        name?: string;
        categoryId?: string;
        correlationId?: string;
      };
      const correlationId = payload.correlationId;
      try {
        if (!payload.guildId || !payload.name) {
          throw new Error("guildId and name are required");
        }
        const transport = transportManager.getTransport("discord") as any;
        if (!transport || typeof transport.createTextChannel !== "function") {
          throw new Error("Discord transport does not support channel creation");
        }
        const created = await transport.createTextChannel(payload.guildId, payload.name, payload.categoryId);
        pi.events.emit("msg-bridge:discord-create-channel-result", {
          ok: true,
          correlationId,
          channelId: created.id,
          channelName: created.name,
          guildId: payload.guildId,
        });
      } catch (err: any) {
        pi.events.emit("msg-bridge:discord-create-channel-result", {
          ok: false,
          correlationId,
          error: err?.message ?? String(err),
          guildId: payload.guildId,
        });
      }
    });

    pi.events.on("msg-bridge:send", async (data) => {
      const payload = data as {
        transport?: string;
        chatId?: string;
        text?: string;
        correlationId?: string;
      };

      if (!payload.transport || !payload.chatId || !payload.text) {
        return;
      }

      try {
        await transportManager.sendMessage(payload.chatId, payload.transport, payload.text);
        pi.events.emit("msg-bridge:sent", {
          ok: true,
          correlationId: payload.correlationId,
          transport: payload.transport,
          chatId: payload.chatId,
        });
      } catch (err: any) {
        pi.events.emit("msg-bridge:sent", {
          ok: false,
          correlationId: payload.correlationId,
          transport: payload.transport,
          chatId: payload.chatId,
          error: err?.message ?? String(err),
        });
      }
    });

    updateWidget();
  });

  /**
   * Handle turn start - send typing indicator
   */
  pi.on("turn_start", async () => {
    if (!activeRemoteChat && remoteTurnQueue.length > 0) {
      activeRemoteChat = remoteTurnQueue.shift() ?? null;
    }

    if (activeRemoteChat) {
      pi.events.emit("msg-bridge:active-request", {
        state: "start",
        requestId: activeRemoteChat.requestId,
        chatId: activeRemoteChat.chatId,
        transport: activeRemoteChat.transport,
        messageId: activeRemoteChat.messageId,
      });

      try {
        await transportManager.sendTyping(
          activeRemoteChat.chatId,
          activeRemoteChat.transport
        );
      } catch {
        // Ignore typing indicator errors
      }
    }
  });

  /**
   * Handle turn end - send response back to messenger
   */
  pi.on("turn_end", async (event) => {
    if (!activeRemoteChat) return;

    try {
      const message = event.message as AssistantMessage;
      const responseText = extractTextFromMessage(message);
      const toolCallsText = formatToolCalls(message);
      const hasPendingTools = hasToolCalls(message);

      const parts: string[] = [];
      if (responseText) parts.push(responseText);
      if (toolCallsText) parts.push(toolCallsText);

      const errorMessage = (message as any).errorMessage as string | undefined;
      if (parts.length === 0 && errorMessage) {
        parts.push(`❌ Model/provider error\n\n${errorMessage}`);
      }

      if (parts.length === 0) return;

      const fullText = parts.join("\n\n");

      // Split long messages for Telegram's 4096 char limit
      const chunks = splitMessage(fullText, 4000);
      for (const chunk of chunks) {
        await transportManager.sendMessage(
          activeRemoteChat.chatId,
          activeRemoteChat.transport,
          chunk
        );
      }

      pi.events.emit("msg-bridge:outgoing", {
        requestId: activeRemoteChat.requestId,
        transport: activeRemoteChat.transport,
        chatId: activeRemoteChat.chatId,
        hasPendingTools,
        queuedAt: activeRemoteChat.queuedAt,
      });

      if (!hasPendingTools) {
        pi.events.emit("msg-bridge:active-request", {
          state: "end",
          requestId: activeRemoteChat.requestId,
          chatId: activeRemoteChat.chatId,
          transport: activeRemoteChat.transport,
          messageId: activeRemoteChat.messageId,
        });
        activeRemoteChat = null;
      }
    } catch (err) {
      const transport = activeRemoteChat?.transport ?? "unknown";
      ctx.ui.notify(
        `Failed to send response to ${transport}: ${(err as Error).message}`,
        "error"
      );
      if (activeRemoteChat) {
        pi.events.emit("msg-bridge:active-request", {
          state: "end",
          requestId: activeRemoteChat.requestId,
          chatId: activeRemoteChat.chatId,
          transport: activeRemoteChat.transport,
          messageId: activeRemoteChat.messageId,
        });
      }
      activeRemoteChat = null;
    }
  });

  /**
   * Cleanup on session exit — release locks and disconnect transports
   */
  pi.on("session_shutdown", async () => {
    await transportManager.disconnectAll();
    releaseDiscordIntakeLock();
    releaseLock();
  });

  /**
   * /msg-bridge command - show status or manage connections
   */
  pi.registerCommand("msg-bridge", {
    description: "Manage remote messenger connections (help|status|connect|disconnect|configure|widget)",
    handler: async (args: string, context) => {
      const parts = args.trim().split(/\s+/).filter(p => p.length > 0);
      const subcommand = parts[0] || "";

    // No subcommand → open interactive menu
    if (!subcommand || subcommand === "menu") {
      await openMainMenu({
        ui: context.ui,
        transportManager,
        auth,
        updateWidget,
      });
      return;
    }

    switch (subcommand) {
      case "help": {
        const helpText = [
          "━━━ Message Bridge Commands ━━━",
          "",
          "/msg-bridge                   Open interactive menu",
          "/msg-bridge help              Show this help",
          "/msg-bridge status            Show connection and user status",
          "/msg-bridge connect           Connect to all transports",
          "/msg-bridge disconnect        Disconnect from all transports",
          "/msg-bridge configure telegram <token>",
          "                              Configure Telegram bot",
          "/msg-bridge configure whatsapp",
          "                              Configure WhatsApp (scan QR)",
          "/msg-bridge widget            Toggle status widget on/off",
          "",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        ];
        context.ui.notify(helpText.join("\n"), "info");
        break;
      }
      case "connect":
        if (!acquireLock()) {
          context.ui.notify("⚠️ Another msg-bridge instance is already connected. Run /msg-bridge disconnect there first.", "warning");
          break;
        }
        try {
          const cfg = loadConfig();
          ensureDiscordTransportRegistered(cfg);
          await transportManager.connectAll();
          cfg.autoConnect = true;
          saveConfig(cfg);
          context.ui.notify("✅ Connected to all configured transports", "info");
          updateWidget();
        } catch (err) {
          releaseLock();
          context.ui.notify(
            `❌ Connection failed: ${(err as Error).message}`,
            "error"
          );
        }
        break;

      case "disconnect": {
        await transportManager.disconnectAll();
        releaseLock();
        const cfg = loadConfig();
        cfg.autoConnect = false;
        saveConfig(cfg);
        context.ui.notify("🔌 Disconnected from all transports", "info");
        updateWidget();
        break;
      }

      case "configure": {
        const platform = parts[1];
        const token = parts.slice(2).join(" ");

        if (!platform) {
          context.ui.notify("Usage: /msg-bridge configure <platform> [token/path]", "error");
          return;
        }

        const config = loadConfig();

        switch (platform.toLowerCase()) {
          case "telegram": {
            if (!token) {
              context.ui.notify("Usage: /msg-bridge configure telegram <bot-token>", "error");
              return;
            }
            config.telegram = { token };
            saveConfig(config);
            const telegramProvider = new TelegramProvider(token, auth);
            transportManager.addTransport(telegramProvider);
            if (acquireLock()) {
              try {
                await telegramProvider.connect();
                context.ui.notify("✅ Telegram configured and connected", "info");
              } catch (_err) {
                releaseLock();
                context.ui.notify("✅ Telegram configured (run /msg-bridge connect to activate)", "info");
              }
            } else {
              context.ui.notify("✅ Telegram configured (another instance is connected — run /msg-bridge connect later)", "info");
            }
            updateWidget();
            break;
          }

          case "whatsapp": {
            config.whatsapp = token ? { authPath: token } : {};
            saveConfig(config);
            const whatsappConfig = {
              ...config.whatsapp,
              debug: config.debug,
              onQr: (qrAscii: string) => {
                context.ui.notify(`📱 Scan this WhatsApp QR code:\n\n${qrAscii}`, "info");
              },
              onStatus: (message: string, level: "info" | "warning" | "error" = "info") => {
                context.ui.notify(message, level);
              },
            };
            const whatsappProvider = new WhatsAppProvider(whatsappConfig, auth);
            transportManager.addTransport(whatsappProvider);
            if (acquireLock()) {
              try {
                await whatsappProvider.connect(true);
                context.ui.notify("✅ WhatsApp configured and connecting (scan QR code in terminal)...", "info");
              } catch (err) {
                releaseLock();
                context.ui.notify(`⚠️ WhatsApp setup error: ${(err as Error).message}`, "error");
              }
            } else {
              context.ui.notify("✅ WhatsApp configured (another instance is connected — run /msg-bridge connect later)", "info");
            }
            updateWidget();
            break;
          }

          case "slack": {
            const parts2 = token.split(/\s+/);
            const botToken = parts2[0];
            const appToken = parts2[1];

            if (!botToken || !appToken) {
              context.ui.notify("Usage: /msg-bridge configure slack <bot-token> <app-token>", "error");
              return;
            }

            config.slack = { botToken, appToken };
            saveConfig(config);
            const slackProvider = new SlackProvider(config.slack, auth);
            transportManager.addTransport(slackProvider);
            if (acquireLock()) {
              try {
                await slackProvider.connect();
                context.ui.notify("✅ Slack configured and connected", "info");
              } catch (err) {
                releaseLock();
                context.ui.notify(`⚠️ Slack setup error: ${(err as Error).message}`, "error");
              }
            } else {
              context.ui.notify("✅ Slack configured (another instance is connected — run /msg-bridge connect later)", "info");
            }
            updateWidget();
            break;
          }

          case "discord": {
            if (!token) {
              context.ui.notify("Usage: /msg-bridge configure discord <bot-token>", "error");
              return;
            }

            config.discord = { token };
            saveConfig(config);

            const registered = ensureDiscordTransportRegistered(config);
            if (!registered) {
              context.ui.notify(
                `⚠️ Discord configured, but this process is passive (${discordLockReason}).`,
                "warning"
              );
              updateWidget();
              break;
            }

            const discordTransport = transportManager.getTransport("discord");
            try {
              if (discordTransport && !discordTransport.isConnected) {
                await discordTransport.connect();
              }
              context.ui.notify("✅ Discord configured and connected", "info");
            } catch (err) {
              context.ui.notify(`⚠️ Discord setup error: ${(err as Error).message}`, "error");
            }
            updateWidget();
            break;
          }

          default:
            context.ui.notify(`❌ Unknown platform: ${platform}`, "error");
        }
        break;
      }

      case "widget": {
        const cfg2 = loadConfig();
        cfg2.showWidget = cfg2.showWidget === false;
        saveConfig(cfg2);
        const widgetState = cfg2.showWidget !== false ? "shown" : "hidden";
        context.ui.notify(`📊 Status widget ${widgetState}`, "info");
        updateWidget();
        break;
      }

      case "status": {
        const stats = auth.getStats();
        const status = transportManager.getStatus();
        const lines = [
          "━━━ Message Bridge Status ━━━",
          "",
          `Discord intake lock: ${hasDiscordIntakeLock ? "owned" : `passive (${discordLockReason})`}`,
          `Remote queue depth: ${remoteTurnQueue.length}${activeRemoteChat ? " (+1 active)" : ""}`,
          "",
          "Transports:",
          ...status.map(
            (s) => `  ${s.connected ? "●" : "○"} ${s.type}`
          ),
          "",
          `Trusted Users: ${stats.trustedUsers}`,
        ];

        if (stats.trustedUsers > 0) {
          for (const [transport, userIds] of Object.entries(stats.usersByTransport)) {
            if (userIds.length > 0) {
              lines.push(`  └─ ${transport}: ${userIds.join(", ")}`);
            }
          }
        }

        lines.push("");
        lines.push(`Channels: ${stats.channels}`);
        lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        context.ui.notify(lines.join("\n"), "info");
        break;
      }
      default:
        context.ui.notify(`Unknown subcommand: ${subcommand}. Run /msg-bridge help`, "warning");
        break;
    }
    },
  });
}
