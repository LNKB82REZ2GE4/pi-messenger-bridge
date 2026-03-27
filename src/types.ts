/**
 * External message received from a messenger transport
 */
export interface ExternalMessage {
  /** Unique chat/channel identifier */
  chatId: string;
  /** Transport type (telegram, whatsapp, etc) */
  transport: string;
  /** Message content/text */
  content: string;
  /** Sender username */
  username: string;
  /** Sender user ID */
  userId: string;
  /** Message timestamp */
  timestamp: Date;
  /** Unique message identifier */
  messageId: string;
  /** Is this a group/channel message? */
  isGroupChat: boolean;
  /** Was the bot mentioned? (for group chats) */
  wasMentioned?: boolean;
  /** Reply target message id if the user replied to a message */
  replyToMessageId?: string;
  /** Discord guild id (when available) */
  guildId?: string;
  /** Discord channel name (when available) */
  channelName?: string;
}

/**
 * Configuration for msg-bridge extension
 */
export interface MsgBridgeConfig {
  telegram?: {
    token: string;
  };
  whatsapp?: {
    authPath?: string;
  };
  slack?: {
    botToken: string;
    appToken: string;
  };
  discord?: {
    token: string;
  };
  auth?: {
    trustedUsers?: string[];
    adminUserId?: string;
    channels?: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }>;
  };
  autoConnect?: boolean;
  showWidget?: boolean;
  debug?: boolean;
}

/**
 * Pending remote chat session tracking
 */
export interface PendingRemoteChat {
  chatId: string;
  transport: string;
  username: string;
  messageId: string;
  requestId: string;
  queuedAt: number;
  synthetic?: boolean;
}

/**
 * Transport connection status
 */
export interface TransportStatus {
  type: string;
  connected: boolean;
  error?: string;
}
