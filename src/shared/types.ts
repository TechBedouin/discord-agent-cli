/**
 * Shared Discord API v10, User/Bot Auth, Daemon Cache, IPC DTO, and Watch JSONL types.
 */

export type Snowflake = string;
export type IsoTimestamp = string;
export type DiscordAuthMode = "user" | "bot";

// ---------------------------------------------------------------------------
// Discord Gateway API v10
// ---------------------------------------------------------------------------

export const GatewayOpcode = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  VOICE_STATE_UPDATE: 4,
  RESUME: 6,
  RECONNECT: 7,
  REQUEST_GUILD_MEMBERS: 8,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

export type GatewayOpcodeValue = (typeof GatewayOpcode)[keyof typeof GatewayOpcode];

export const GatewayCloseCode = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  UNKNOWN_ERROR: 4000,
  UNKNOWN_OPCODE: 4001,
  DECODE_ERROR: 4002,
  NOT_AUTHENTICATED: 4003,
  AUTHENTICATION_FAILED: 4004,
  ALREADY_AUTHENTICATED: 4005,
  INVALID_SEQ: 4007,
  RATE_LIMITED: 4008,
  SESSION_TIMED_OUT: 4009,
  INVALID_SHARD: 4010,
  SHARDING_REQUIRED: 4011,
  INVALID_API_VERSION: 4012,
  INVALID_INTENTS: 4013,
  DISALLOWED_INTENTS: 4014,
} as const;

export type GatewayCloseCodeValue =
  (typeof GatewayCloseCode)[keyof typeof GatewayCloseCode];

/**
 * Gateway close codes that cannot be recovered via reconnect/resume and must halt retries.
 */
export const FATAL_GATEWAY_CLOSE_CODES: ReadonlySet<number> = new Set([
  GatewayCloseCode.AUTHENTICATION_FAILED,
  GatewayCloseCode.INVALID_SHARD,
  GatewayCloseCode.SHARDING_REQUIRED,
  GatewayCloseCode.INVALID_API_VERSION,
  GatewayCloseCode.INVALID_INTENTS,
  GatewayCloseCode.DISALLOWED_INTENTS,
]);

export type GatewayConnectionState =
  | "disconnected"
  | "connecting"
  | "identifying"
  | "resuming"
  | "ready"
  | "reconnecting"
  | "fatal";

export interface GatewayPayload<T = unknown> {
  op: GatewayOpcodeValue;
  d: T;
  s: number | null;
  t: string | null;
}

export interface GatewayHelloData {
  heartbeat_interval: number;
}

export interface GatewayIdentifyProperties {
  $os?: string;
  $browser?: string;
  $device?: string;
  os?: string;
  browser?: string;
  device?: string;
  [key: string]: unknown;
}

export interface GatewayIdentifyData {
  token: string;
  intents?: number;
  properties: GatewayIdentifyProperties;
  compress?: boolean;
  large_threshold?: number;
  shard?: [number, number];
  capabilities?: number;
  presence?: Record<string, unknown>;
  client_state?: Record<string, unknown>;
}

export interface GatewayResumeData {
  token: string;
  session_id: string;
  seq: number;
}

export interface GatewaySessionStartLimit {
  total: number;
  remaining: number;
  reset_after: number;
  max_concurrency: number;
}

export interface GatewayBotInfo {
  url: string;
  shards: number;
  session_start_limit: GatewaySessionStartLimit;
}

export const DiscordRelationshipType = {
  FRIEND: 1,
  BLOCKED: 2,
  PENDING_INCOMING: 3,
  PENDING_OUTGOING: 4,
  IMPLICIT: 5,
} as const;

export type DiscordRelationshipTypeValue =
  (typeof DiscordRelationshipType)[keyof typeof DiscordRelationshipType];

export interface DiscordRelationship {
  id: Snowflake;
  type: number;
  nickname?: string | null;
  user?: DiscordUser;
}

export interface DiscordUserSettings {
  locale?: string;
  theme?: string;
  status?: string;
  custom_status?: {
    text?: string | null;
    emoji_id?: Snowflake | null;
    emoji_name?: string | null;
    expires_at?: IsoTimestamp | null;
  } | null;
  [key: string]: unknown;
}

export interface DiscordGuildProperties {
  id?: Snowflake;
  name?: string;
  icon?: string | null;
  owner_id?: Snowflake;
  description?: string | null;
}

export interface DiscordUserReadyGuild {
  id: Snowflake;
  unavailable?: boolean;
  name?: string;
  icon?: string | null;
  owner_id?: Snowflake;
  properties?: DiscordGuildProperties;
  channels?: DiscordChannel[];
  threads?: DiscordChannel[];
  members?: DiscordGuildMember[];
  roles?: DiscordRole[];
  member_count?: number;
  joined_at?: IsoTimestamp;
}

export interface DiscordReadStateEntry {
  id: Snowflake;
  last_message_id?: Snowflake | null;
  mention_count?: number;
  last_pin_timestamp?: IsoTimestamp | null;
}

export interface GatewayReadyData {
  v: number;
  user: DiscordUser;
  guilds: Array<
    DiscordUnavailableGuild | DiscordGuild | DiscordUserReadyGuild
  >;
  session_id: string;
  resume_gateway_url?: string;
  shard?: [number, number];
  application?: {
    id: Snowflake;
    flags: number;
  };
  private_channels?: DiscordChannel[];
  relationships?: DiscordRelationship[];
  user_settings?: DiscordUserSettings;
  merged_members?: DiscordGuildMember[][];
  users?: DiscordUser[];
  read_state?: DiscordReadStateEntry[];
}

export interface GatewayGuildDeleteData {
  id: Snowflake;
  unavailable?: boolean;
}

export interface GatewayMessageDeleteData {
  id: Snowflake;
  channel_id: Snowflake;
  guild_id?: Snowflake;
}

export interface GatewayMessageDeleteBulkData {
  ids: Snowflake[];
  channel_id: Snowflake;
  guild_id?: Snowflake;
}

export interface GatewayReactionAddData {
  user_id: Snowflake;
  channel_id: Snowflake;
  message_id: Snowflake;
  guild_id?: Snowflake;
  member?: DiscordGuildMember;
  emoji: DiscordEmoji;
  message_author_id?: Snowflake;
}

export interface GatewayReactionRemoveData {
  user_id: Snowflake;
  channel_id: Snowflake;
  message_id: Snowflake;
  guild_id?: Snowflake;
  emoji: DiscordEmoji;
}

export interface GatewayReactionRemoveAllData {
  channel_id: Snowflake;
  message_id: Snowflake;
  guild_id?: Snowflake;
}

export interface GatewayReactionRemoveEmojiData {
  channel_id: Snowflake;
  message_id: Snowflake;
  guild_id?: Snowflake;
  emoji: DiscordEmoji;
}

// ---------------------------------------------------------------------------
// Discord REST API v10 Entities & Errors
// ---------------------------------------------------------------------------

export interface DiscordUser {
  id: Snowflake;
  username: string;
  discriminator: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
  system?: boolean;
}

export interface DiscordRole {
  id: Snowflake;
  name: string;
  permissions: string;
  position: number;
}

export interface DiscordGuildMember {
  user?: DiscordUser;
  nick?: string | null;
  roles: Snowflake[];
  joined_at: IsoTimestamp;
}

export interface DiscordUnavailableGuild {
  id: Snowflake;
  unavailable?: boolean;
}

export interface DiscordGuild {
  id: Snowflake;
  name: string;
  icon?: string | null;
  owner_id: Snowflake;
  properties?: DiscordGuildProperties;
  channels?: DiscordChannel[];
  threads?: DiscordChannel[];
  members?: DiscordGuildMember[];
  roles?: DiscordRole[];
  member_count?: number;
  unavailable?: boolean;
}

export interface DiscordPartialGuild {
  id: Snowflake;
  name: string;
  icon?: string | null;
  banner?: string | null;
  owner?: boolean;
  owner_id?: Snowflake;
  permissions?: string;
  features?: string[];
  approximate_member_count?: number;
  approximate_presence_count?: number;
}

export interface DiscordInviteGuild {
  id: Snowflake;
  name: string;
  icon?: string | null;
  splash?: string | null;
  banner?: string | null;
  description?: string | null;
  features?: string[];
  verification_level?: number;
  vanity_url_code?: string | null;
}

export interface DiscordInviteChannel {
  id: Snowflake;
  name?: string | null;
  type: number;
}

export interface DiscordInvite {
  code: string;
  type?: number;
  guild?: DiscordInviteGuild;
  channel?: DiscordInviteChannel | null;
  inviter?: DiscordUser;
  approximate_member_count?: number;
  approximate_presence_count?: number;
  expires_at?: IsoTimestamp | null;
}

export interface DiscordThreadMember {
  id?: Snowflake;
  user_id?: Snowflake;
  join_timestamp?: IsoTimestamp;
  flags?: number;
}

export interface DiscordActiveThreadsResponse {
  threads: DiscordChannel[];
  members?: DiscordThreadMember[];
  has_more?: boolean;
}

export interface DiscordCreateDmBody {
  recipient_id: Snowflake;
}

export const DiscordChannelType = {
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_VOICE: 2,
  GROUP_DM: 3,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
  ANNOUNCEMENT_THREAD: 10,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
  GUILD_STAGE_VOICE: 13,
  GUILD_FORUM: 15,
  GUILD_MEDIA: 16,
} as const;

export type DiscordChannelTypeValue =
  (typeof DiscordChannelType)[keyof typeof DiscordChannelType];

export interface DiscordChannel {
  id: Snowflake;
  type: number;
  guild_id?: Snowflake;
  position?: number;
  name?: string | null;
  topic?: string | null;
  nsfw?: boolean;
  last_message_id?: Snowflake | null;
  parent_id?: Snowflake | null;
  recipients?: DiscordUser[];
  rate_limit_per_user?: number;
  thread_metadata?: {
    archived?: boolean;
    auto_archive_duration?: number;
    archive_timestamp?: IsoTimestamp;
    locked?: boolean;
  };
}

export interface DiscordEmoji {
  id: Snowflake | null;
  name: string | null;
  animated?: boolean;
}

export interface DiscordReaction {
  count: number;
  me: boolean;
  emoji: DiscordEmoji;
}

export interface DiscordAttachment {
  id: Snowflake;
  filename: string;
  size: number;
  url: string;
  proxy_url?: string;
  content_type?: string;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  timestamp?: IsoTimestamp;
}

export interface DiscordMessageReference {
  message_id?: Snowflake;
  channel_id?: Snowflake;
  guild_id?: Snowflake;
}

export const DiscordMessageType = {
  DEFAULT: 0,
  RECIPIENT_ADD: 1,
  RECIPIENT_REMOVE: 2,
  CALL: 3,
  CHANNEL_NAME_CHANGE: 4,
  CHANNEL_ICON_CHANGE: 5,
  CHANNEL_PINNED_MESSAGE: 6,
  USER_JOIN: 7,
  REPLY: 19,
  CHAT_INPUT_COMMAND: 20,
  THREAD_STARTER_MESSAGE: 21,
} as const;

export type DiscordMessageTypeValue =
  (typeof DiscordMessageType)[keyof typeof DiscordMessageType];

export interface DiscordMessage {
  id: Snowflake;
  channel_id: Snowflake;
  guild_id?: Snowflake;
  author: DiscordUser;
  content: string;
  timestamp: IsoTimestamp;
  edited_timestamp?: IsoTimestamp | null;
  tts?: boolean;
  mention_everyone?: boolean;
  mentions?: DiscordUser[];
  mention_roles?: Snowflake[];
  attachments?: DiscordAttachment[];
  embeds?: DiscordEmbed[];
  reactions?: DiscordReaction[];
  type: number;
  message_reference?: DiscordMessageReference;
}

export interface DiscordCreateMessageBody {
  content: string;
  message_reference?: {
    message_id: Snowflake;
    fail_if_not_exists?: boolean;
  };
}

export interface DiscordRestErrorBody {
  code: number;
  message: string;
  errors?: Record<string, unknown>;
}

export interface DiscordRateLimitErrorBody {
  message: string;
  retry_after: number;
  global: boolean;
  code?: number;
}

export type RateLimitScope = "user" | "global" | "shared";

export interface RateLimitBucketSnapshot {
  routeKey: string;
  bucketHash: string;
  limit: number;
  remaining: number;
  resetAfterMs: number;
  resetAt: IsoTimestamp;
  queuedCount: number;
}

// ---------------------------------------------------------------------------
// Authoritative Daemon Cache & Unread / Mention Watermarks
// ---------------------------------------------------------------------------

export interface CachedUser {
  id: Snowflake;
  username: string;
  discriminator: string;
  globalName: string | null;
  bot: boolean;
  updatedAt: IsoTimestamp;
}

export interface CachedGuild {
  id: Snowflake;
  name: string;
  icon?: string | null;
  ownerId: Snowflake;
  unavailable: boolean;
  memberCount: number | null;
  botRoleIds: Snowflake[];
  channelIds: Snowflake[];
  updatedAt: IsoTimestamp;
}

export interface CachedGuildMember {
  userId: Snowflake;
  guildId: Snowflake;
  nickname: string | null;
  roleIds: Snowflake[];
  joinedAt: IsoTimestamp | null;
  updatedAt: IsoTimestamp;
}

export interface CachedChannel {
  id: Snowflake;
  type: number;
  guildId: Snowflake | null;
  name: string;
  topic: string | null;
  parentId: Snowflake | null;
  position?: number | null;
  nsfw?: boolean;
  recipientIds: Snowflake[];
  lastMessageId: Snowflake | null;
  isDm: boolean;
  updatedAt: IsoTimestamp;
}

export interface CachedReaction {
  emojiKey: string;
  emojiName: string | null;
  emojiId: Snowflake | null;
  animated: boolean;
  count: number;
  me: boolean;
}

export interface CachedAttachment {
  id: Snowflake;
  filename: string;
  size: number;
  url: string;
  contentType: string | null;
}

export interface CachedMessage {
  id: Snowflake;
  channelId: Snowflake;
  guildId: Snowflake | null;
  author: CachedUser;
  content: string;
  timestamp: IsoTimestamp;
  editedTimestamp: IsoTimestamp | null;
  mentionsBot: boolean;
  mentionEveryone: boolean;
  mentionUserIds: Snowflake[];
  mentionRoleIds: Snowflake[];
  attachments: CachedAttachment[];
  reactions: CachedReaction[];
  replyToMessageId: Snowflake | null;
}

export interface ChannelWatermark {
  channelId: Snowflake;
  lastReadMessageId: Snowflake | null;
  lastMessageId: Snowflake | null;
  unreadCount: number;
  mentionCount: number;
  updatedAt: IsoTimestamp;
}

export interface UnreadRecord {
  channelId: Snowflake;
  channelName: string;
  guildId: Snowflake | null;
  guildName: string | null;
  isDm: boolean;
  lastReadMessageId: Snowflake | null;
  lastMessageId: Snowflake;
  unreadCount: number;
  mentionCount: number;
  hasMention: boolean;
  latestMessageTimestamp: IsoTimestamp;
  latestMessagePreview: string;
  latestAuthorName: string;
}

// ---------------------------------------------------------------------------
// Local IPC Lockfile, Envelopes & Command DTOs
// ---------------------------------------------------------------------------

export interface DaemonLockfile {
  pid: number;
  host: string;
  port: number;
  startedAt: IsoTimestamp;
  version?: string;
}

export const IpcErrorCode = {
  UNAUTHORIZED: "UNAUTHORIZED",
  BAD_REQUEST: "BAD_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  DAEMON_NOT_READY: "DAEMON_NOT_READY",
  DAEMON_UNREACHABLE: "DAEMON_UNREACHABLE",
  DISCORD_API_ERROR: "DISCORD_API_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type IpcErrorCodeValue = (typeof IpcErrorCode)[keyof typeof IpcErrorCode];

export interface IpcErrorPayload {
  code: IpcErrorCodeValue | string;
  message: string;
  status: number;
  discordCode?: number;
  retryAfterMs?: number;
  details?: unknown;
}

export interface IpcSuccessEnvelope<T> {
  ok: true;
  data: T;
}

export interface IpcErrorEnvelope {
  ok: false;
  error: IpcErrorPayload;
}

export type IpcResponseEnvelope<T> = IpcSuccessEnvelope<T> | IpcErrorEnvelope;

export interface GatewayStatusSnapshot {
  state: GatewayConnectionState;
  authMode?: DiscordAuthMode;
  sessionId: string | null;
  seq: number | null;
  gatewayUrl: string | null;
  resumeGatewayUrl: string | null;
  heartbeatIntervalMs: number | null;
  lastHeartbeatAt: IsoTimestamp | null;
  lastHeartbeatAckAt: IsoTimestamp | null;
  latencyMs: number | null;
  reconnectAttempts: number;
  lastError: string | null;
}

export interface CacheStatusSnapshot {
  guilds: number;
  channels: number;
  dmChannels: number;
  users: number;
  cachedMessages: number;
  unreadChannels: number;
  totalUnreadMessages: number;
  totalMentions: number;
  activeWatchers: number;
}

export interface RateLimitStatusSnapshot {
  trackedBuckets: number;
  globalBlockedUntil: IsoTimestamp | null;
}

export interface DaemonStatusResult {
  pid: number;
  startedAt: IsoTimestamp;
  uptimeMs: number;
  host: string;
  port: number;
  authMode?: DiscordAuthMode;
  gateway: GatewayStatusSnapshot;
  botUser: CachedUser | null;
  cache: CacheStatusSnapshot;
  rateLimits: RateLimitStatusSnapshot;
}

export interface UnreadQuery {
  includeDms?: boolean;
  mentionsOnly?: boolean;
}

export interface UnreadResult {
  totalUnreadChannels: number;
  totalUnreadMessages: number;
  totalMentions: number;
  items: UnreadRecord[];
}

export interface ReadMessagesRequest {
  limit?: number;
  before?: Snowflake;
  after?: Snowflake;
  markRead?: boolean;
}

export interface ReadMessagesResult {
  channel: CachedChannel;
  messages: CachedMessage[];
  source: "cache" | "rest";
  markedReadUpTo: Snowflake | null;
}

export interface SendMessageRequest {
  content: string;
  replyToMessageId?: Snowflake;
  typing?: boolean;
}

export interface SendMessageResult {
  message: CachedMessage;
}

export interface ReactMessageRequest {
  emoji: string;
  remove?: boolean;
}

export interface ReactMessageResult {
  channelId: Snowflake;
  messageId: Snowflake;
  emoji: string;
  action: "added" | "removed";
}

export interface JoinGuildRequest {
  invite: string;
}

export interface GuildSummary {
  id: Snowflake;
  name: string;
  icon: string | null;
  ownerId: Snowflake | null;
  owner?: boolean;
  memberCount: number | null;
  approximatePresenceCount?: number | null;
  unavailable?: boolean;
}

export interface JoinGuildChannelInfo {
  id: Snowflake;
  name: string | null;
  type: number;
}

export interface JoinGuildResult {
  inviteCode: string;
  guild: GuildSummary | null;
  channel: JoinGuildChannelInfo | null;
}

export interface GuildsResult {
  totalGuilds: number;
  guilds: GuildSummary[];
  source: "cache" | "rest";
}

export interface GuildChannelSummary {
  id: Snowflake;
  guildId: Snowflake;
  name: string;
  type: number;
  topic: string | null;
  parentId: Snowflake | null;
  position: number | null;
  nsfw?: boolean;
  lastMessageId: Snowflake | null;
  isCategory: boolean;
  isThread: boolean;
}

export interface GuildChannelsResult {
  guildId: Snowflake;
  guildName: string | null;
  totalChannels: number;
  channels: GuildChannelSummary[];
  categories: GuildChannelSummary[];
  threads: GuildChannelSummary[];
  source: "cache" | "rest";
}

export interface ChannelMembersQuery {
  limit?: number;
}

export interface ChannelMemberSummary {
  userId: Snowflake;
  username: string;
  discriminator: string;
  globalName: string | null;
  nickname: string | null;
  bot: boolean;
  roleIds: Snowflake[];
  joinedAt?: IsoTimestamp | null;
}

export interface ChannelMembersResult {
  channelId: Snowflake;
  guildId: Snowflake | null;
  totalMembers: number;
  members: ChannelMemberSummary[];
  source: "cache" | "rest" | "mixed";
}

export interface DirectMessageRequest {
  userId: Snowflake;
  content: string;
  typing?: boolean;
}

export interface DirectMessageResult {
  channel: CachedChannel;
  message: CachedMessage;
}

export interface DmRecipientSummary {
  id: Snowflake;
  username: string;
  discriminator: string;
  globalName: string | null;
  bot: boolean;
}

export interface DmChannelSummary {
  channelId: Snowflake;
  type: number;
  name: string;
  recipientId: Snowflake | null;
  recipientIds: Snowflake[];
  username: string | null;
  globalName: string | null;
  recipients: DmRecipientSummary[];
  lastMessageId: Snowflake | null;
}

export interface DmChannelsResult {
  totalDms: number;
  dms: DmChannelSummary[];
  source: "cache" | "rest";
}

export interface DaemonStopResult {
  stopping: true;
  pid: number;
}

// ---------------------------------------------------------------------------
// Watch NDJSON / JSONL Streaming Events
// ---------------------------------------------------------------------------

export const WatchEventTypeValue = {
  READY: "ready",
  MESSAGE_CREATE: "message_create",
  MESSAGE_UPDATE: "message_update",
  MESSAGE_DELETE: "message_delete",
  REACTION_ADD: "reaction_add",
  REACTION_REMOVE: "reaction_remove",
  GATEWAY_STATE: "gateway_state",
} as const;

export type WatchEventType =
  (typeof WatchEventTypeValue)[keyof typeof WatchEventTypeValue];

export interface WatchEmojiInfo {
  emojiKey: string;
  emojiName: string | null;
  emojiId: Snowflake | null;
  animated: boolean;
}

export interface WatchReadyEvent {
  type: "ready";
  timestamp: IsoTimestamp;
  channelId: Snowflake;
  channel: CachedChannel | null;
  gatewayState: GatewayConnectionState;
}

export interface WatchMessageCreateEvent {
  type: "message_create";
  timestamp: IsoTimestamp;
  channelId: Snowflake;
  message: CachedMessage;
}

export interface WatchMessageUpdateEvent {
  type: "message_update";
  timestamp: IsoTimestamp;
  channelId: Snowflake;
  message: CachedMessage;
}

export interface WatchMessageDeleteEvent {
  type: "message_delete";
  timestamp: IsoTimestamp;
  channelId: Snowflake;
  guildId: Snowflake | null;
  messageId: Snowflake;
}

export interface WatchReactionAddEvent extends WatchEmojiInfo {
  type: "reaction_add";
  timestamp: IsoTimestamp;
  channelId: Snowflake;
  guildId: Snowflake | null;
  messageId: Snowflake;
  userId: Snowflake;
}

export interface WatchReactionRemoveEvent extends WatchEmojiInfo {
  type: "reaction_remove";
  timestamp: IsoTimestamp;
  channelId: Snowflake;
  guildId: Snowflake | null;
  messageId: Snowflake;
  userId: Snowflake;
}

export interface WatchGatewayStateEvent {
  type: "gateway_state";
  timestamp: IsoTimestamp;
  channelId: Snowflake;
  state: GatewayConnectionState;
  detail: string | null;
}

export type WatchEvent =
  | WatchReadyEvent
  | WatchMessageCreateEvent
  | WatchMessageUpdateEvent
  | WatchMessageDeleteEvent
  | WatchReactionAddEvent
  | WatchReactionRemoveEvent
  | WatchGatewayStateEvent;
