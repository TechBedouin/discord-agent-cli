import {
  DEFAULT_CHANNEL_MEMBERS_LIMIT,
  DEFAULT_MAX_MESSAGES_PER_CHANNEL,
} from "../shared/config.js";
import {
  DiscordChannelType,
  WatchEventTypeValue,
  type CacheStatusSnapshot,
  type CachedAttachment,
  type CachedChannel,
  type CachedGuild,
  type CachedGuildMember,
  type CachedMessage,
  type CachedReaction,
  type CachedUser,
  type ChannelMemberSummary,
  type ChannelWatermark,
  type DiscordChannel,
  type DiscordEmoji,
  type DiscordGuild,
  type DiscordGuildMember,
  type DiscordInvite,
  type DiscordMessage,
  type DiscordPartialGuild,
  type DiscordReaction,
  type DiscordRelationship,
  type DiscordUnavailableGuild,
  type DiscordUser,
  type DiscordUserReadyGuild,
  type DiscordUserSettings,
  type DmChannelSummary,
  type DmRecipientSummary,
  type GatewayConnectionState,
  type GatewayGuildDeleteData,
  type GatewayMessageDeleteBulkData,
  type GatewayMessageDeleteData,
  type GatewayReactionAddData,
  type GatewayReactionRemoveAllData,
  type GatewayReactionRemoveData,
  type GatewayReactionRemoveEmojiData,
  type GatewayReadyData,
  type GuildChannelSummary,
  type GuildChannelsResult,
  type GuildSummary,
  type IsoTimestamp,
  type JoinGuildChannelInfo,
  type JoinGuildResult,
  type Snowflake,
  type UnreadQuery,
  type UnreadRecord,
  type UnreadResult,
  type WatchEmojiInfo,
  type WatchEvent,
  type WatchEventType,
  type WatchGatewayStateEvent,
  type WatchMessageCreateEvent,
  type WatchMessageDeleteEvent,
  type WatchMessageUpdateEvent,
  type WatchReactionAddEvent,
  type WatchReactionRemoveEvent,
  type WatchReadyEvent,
} from "../shared/types.js";

export interface StateCacheOptions {
  maxMessagesPerChannel?: number;
  now?: () => Date;
}

export interface GetCachedMessagesOptions {
  limit?: number;
  before?: Snowflake;
  after?: Snowflake;
}

export interface WatchSubscribeOptions {
  emitReady?: boolean;
  gatewayState?: GatewayConnectionState;
}

interface WatchSubscription {
  listener: (event: WatchEvent) => void;
  filter: ReadonlySet<WatchEventType> | null;
}

interface PartialDiscordMessageUpdate {
  id: Snowflake;
  channel_id: Snowflake;
  guild_id?: Snowflake;
  author?: DiscordUser;
  content?: string;
  timestamp?: IsoTimestamp;
  edited_timestamp?: IsoTimestamp | null;
  mention_everyone?: boolean;
  mentions?: DiscordUser[];
  mention_roles?: Snowflake[];
  attachments?: DiscordMessage["attachments"];
  reactions?: DiscordReaction[];
  message_reference?: DiscordMessage["message_reference"];
}

const MAX_PREVIEW_LENGTH = 120;

/**
 * Compares two Discord snowflake IDs numerically using `BigInt` (`-1`, `0`, or `1`).
 */
export function compareSnowflakes(a: Snowflake, b: Snowflake): number {
  const bigA = BigInt(a);
  const bigB = BigInt(b);
  if (bigA < bigB) {
    return -1;
  }
  if (bigA > bigB) {
    return 1;
  }
  return 0;
}

function maxSnowflake(a: Snowflake | null, b: Snowflake | null): Snowflake | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return compareSnowflakes(a, b) >= 0 ? a : b;
}

function extractEmojiInfo(emoji: DiscordEmoji): WatchEmojiInfo {
  const emojiId = emoji.id ?? null;
  const emojiName = emoji.name ?? null;
  const animated = Boolean(emoji.animated);
  const emojiKey =
    emojiId !== null
      ? `${emojiName ?? ""}:${emojiId}`
      : (emojiName ?? "");
  return {
    emojiKey,
    emojiName,
    emojiId,
    animated,
  };
}

function normalizeDiscordReaction(reaction: DiscordReaction): CachedReaction {
  const info = extractEmojiInfo(reaction.emoji);
  return {
    emojiKey: info.emojiKey,
    emojiName: info.emojiName,
    emojiId: info.emojiId,
    animated: info.animated,
    count: reaction.count,
    me: Boolean(reaction.me),
  };
}

function reactionsMatchEmoji(
  reaction: CachedReaction,
  emojiInfo: WatchEmojiInfo,
): boolean {
  if (emojiInfo.emojiId !== null) {
    return reaction.emojiId === emojiInfo.emojiId;
  }
  return (
    reaction.emojiId === null &&
    reaction.emojiName === emojiInfo.emojiName
  );
}

function formatMessagePreview(message: CachedMessage): string {
  const normalized = message.content.replace(/\s+/g, " ").trim();
  if (normalized.length > 0) {
    if (normalized.length <= MAX_PREVIEW_LENGTH) {
      return normalized;
    }
    return `${normalized.slice(0, MAX_PREVIEW_LENGTH - 3)}...`;
  }
  if (message.attachments.length > 0) {
    return `[attachment: ${message.attachments[0]!.filename}]`;
  }
  return "";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDmChannelPayload(channel: DiscordChannel): boolean {
  return (
    channel.type === DiscordChannelType.DM ||
    channel.type === DiscordChannelType.GROUP_DM ||
    channel.guild_id === undefined
  );
}

function isThreadChannelType(type: number): boolean {
  return (
    type === DiscordChannelType.ANNOUNCEMENT_THREAD ||
    type === DiscordChannelType.PUBLIC_THREAD ||
    type === DiscordChannelType.PRIVATE_THREAD
  );
}

function toGuildChannelSummary(ch: CachedChannel): GuildChannelSummary {
  const isCategory = ch.type === DiscordChannelType.GUILD_CATEGORY;
  const isThread = isThreadChannelType(ch.type);
  const summary: GuildChannelSummary = {
    id: ch.id,
    guildId: ch.guildId ?? "",
    name: ch.name,
    type: ch.type,
    topic: ch.topic,
    parentId: ch.parentId,
    position: ch.position ?? null,
    lastMessageId: ch.lastMessageId,
    isCategory,
    isThread,
  };
  if (ch.nsfw !== undefined) {
    summary.nsfw = ch.nsfw;
  }
  return summary;
}

function compareGuildChannels(
  a: GuildChannelSummary,
  b: GuildChannelSummary,
): number {
  const posA = a.position ?? Number.MAX_SAFE_INTEGER;
  const posB = b.position ?? Number.MAX_SAFE_INTEGER;
  if (posA !== posB) {
    return posA - posB;
  }
  return compareSnowflakes(a.id, b.id);
}

/**
 * Authoritative daemon in-memory state cache, unread/mention watermark tracker,
 * and channel-indexed real-time `WatchEvent` pub/sub bus.
 */
export class StateCache {
  public botUser: CachedUser | null = null;
  public readonly guilds: Map<Snowflake, CachedGuild> = new Map();
  public readonly channels: Map<Snowflake, CachedChannel> = new Map();
  public readonly dmChannels: Map<Snowflake, CachedChannel> = new Map();
  public readonly users: Map<Snowflake, CachedUser> = new Map();
  public readonly guildMembers: Map<
    Snowflake,
    Map<Snowflake, CachedGuildMember>
  > = new Map();
  public readonly relationships: Map<Snowflake, DiscordRelationship> = new Map();
  public readonly messagesByChannel: Map<Snowflake, CachedMessage[]> = new Map();
  public readonly restHydratedChannels: Set<Snowflake> = new Set();

  private readonly maxMessagesPerChannel: number;
  private readonly now: () => Date;
  private readonly watermarks: Map<Snowflake, ChannelWatermark> = new Map();
  private readonly latestMessageMetaByChannel: Map<Snowflake, CachedMessage> =
    new Map();
  private readonly subscribersByChannel: Map<Snowflake, Set<WatchSubscription>> =
    new Map();
  private readonly hydratedGuildChannels: Set<Snowflake> = new Set();
  private readonly guildExtras: Map<
    Snowflake,
    { owner?: boolean; approximatePresenceCount?: number | null }
  > = new Map();
  private userSettings: DiscordUserSettings | null = null;
  private gatewayState: GatewayConnectionState = "disconnected";

  constructor(options: StateCacheOptions = {}) {
    const maxMessages =
      options.maxMessagesPerChannel ?? DEFAULT_MAX_MESSAGES_PER_CHANNEL;
    if (!Number.isInteger(maxMessages) || maxMessages < 1) {
      throw new RangeError(
        `Invalid maxMessagesPerChannel "${String(maxMessages)}": expected a positive integer.`,
      );
    }
    this.maxMessagesPerChannel = maxMessages;
    this.now = options.now ?? (() => new Date());
  }

  private nowIso(): IsoTimestamp {
    return this.now().toISOString();
  }

  public getBotUser(): CachedUser | null {
    return this.botUser;
  }

  public getGatewayState(): GatewayConnectionState {
    return this.gatewayState;
  }

  public getChannel(channelId: Snowflake): CachedChannel | null {
    return (
      this.channels.get(channelId) ?? this.dmChannels.get(channelId) ?? null
    );
  }

  public getWatermark(channelId: Snowflake): ChannelWatermark | null {
    return this.watermarks.get(channelId) ?? null;
  }

  public getGuildMember(
    guildId: Snowflake,
    userId: Snowflake,
  ): CachedGuildMember | null {
    return this.guildMembers.get(guildId)?.get(userId) ?? null;
  }

  public getRelationships(): DiscordRelationship[] {
    return Array.from(this.relationships.values(), (rel) => ({
      ...rel,
      ...(rel.user !== undefined ? { user: { ...rel.user } } : {}),
    }));
  }

  public getUserSettings(): DiscordUserSettings | null {
    if (this.userSettings === null) {
      return null;
    }
    const copy: DiscordUserSettings = { ...this.userSettings };
    if (isPlainRecord(this.userSettings.custom_status)) {
      copy.custom_status = { ...this.userSettings.custom_status };
    }
    return copy;
  }

  public findDmChannelByUserId(userId: Snowflake): CachedChannel | null {
    for (const channel of this.dmChannels.values()) {
      if (
        channel.type === DiscordChannelType.DM &&
        channel.recipientIds.includes(userId)
      ) {
        return channel;
      }
    }
    return null;
  }

  public upsertUser(user: DiscordUser): CachedUser {
    const cached: CachedUser = {
      id: user.id,
      username: user.username,
      discriminator: user.discriminator ?? "0",
      globalName: user.global_name ?? null,
      bot: Boolean(user.bot),
      updatedAt: this.nowIso(),
    };
    this.users.set(cached.id, cached);
    return cached;
  }

  public upsertChannel(channel: DiscordChannel): CachedChannel {
    return this.upsertChannelInternal(channel, true);
  }

  public upsertInviteResult(invite: DiscordInvite): JoinGuildResult {
    const nowIso = this.nowIso();
    if (invite.inviter !== undefined) {
      this.upsertUser(invite.inviter);
    }

    let guildSummary: GuildSummary | null = null;
    if (invite.guild !== undefined) {
      const existing = this.guilds.get(invite.guild.id);
      const cachedGuild: CachedGuild = {
        id: invite.guild.id,
        name: invite.guild.name,
        icon:
          invite.guild.icon !== undefined
            ? invite.guild.icon
            : (existing?.icon ?? null),
        ownerId: existing?.ownerId ?? "",
        unavailable: false,
        memberCount:
          invite.approximate_member_count ?? existing?.memberCount ?? null,
        botRoleIds: existing?.botRoleIds ?? [],
        channelIds: existing?.channelIds ?? [],
        updatedAt: nowIso,
      };
      this.guilds.set(cachedGuild.id, cachedGuild);

      if (invite.approximate_presence_count !== undefined) {
        const prevExtras = this.guildExtras.get(cachedGuild.id);
        this.guildExtras.set(cachedGuild.id, {
          ...prevExtras,
          approximatePresenceCount: invite.approximate_presence_count,
        });
      }

      guildSummary = this.toGuildSummary(cachedGuild);
    }

    let channelInfo: JoinGuildChannelInfo | null = null;
    if (invite.channel !== undefined && invite.channel !== null) {
      if (invite.guild !== undefined) {
        this.upsertChannelInternal(
          {
            id: invite.channel.id,
            type: invite.channel.type,
            name: invite.channel.name ?? null,
            guild_id: invite.guild.id,
          },
          true,
        );
      } else if (
        invite.channel.type === DiscordChannelType.DM ||
        invite.channel.type === DiscordChannelType.GROUP_DM
      ) {
        this.upsertChannelInternal(
          {
            id: invite.channel.id,
            type: invite.channel.type,
            name: invite.channel.name ?? null,
          },
          false,
        );
      }

      channelInfo = {
        id: invite.channel.id,
        name: invite.channel.name ?? null,
        type: invite.channel.type,
      };
    }

    return {
      inviteCode: invite.code,
      guild: guildSummary,
      channel: channelInfo,
    };
  }

  public listGuilds(): GuildSummary[] {
    const result: GuildSummary[] = [];
    for (const guild of this.guilds.values()) {
      result.push(this.toGuildSummary(guild));
    }
    return result;
  }

  public upsertPartialGuilds(
    guilds: readonly DiscordPartialGuild[],
  ): GuildSummary[] {
    const nowIso = this.nowIso();
    const summaries: GuildSummary[] = [];

    for (const partial of guilds) {
      if (typeof partial?.id !== "string") {
        continue;
      }
      const existing = this.guilds.get(partial.id);
      const ownerId =
        partial.owner_id ??
        (existing?.ownerId && existing.ownerId.length > 0
          ? existing.ownerId
          : partial.owner === true && this.botUser !== null
            ? this.botUser.id
            : "");

      const cached: CachedGuild = {
        id: partial.id,
        name: partial.name,
        icon:
          partial.icon !== undefined
            ? partial.icon
            : (existing?.icon ?? null),
        ownerId,
        unavailable: false,
        memberCount:
          partial.approximate_member_count ?? existing?.memberCount ?? null,
        botRoleIds: existing?.botRoleIds ?? [],
        channelIds: existing?.channelIds ?? [],
        updatedAt: nowIso,
      };
      this.guilds.set(cached.id, cached);

      if (
        partial.owner !== undefined ||
        partial.approximate_presence_count !== undefined
      ) {
        const prevExtras = this.guildExtras.get(cached.id);
        this.guildExtras.set(cached.id, {
          owner: partial.owner ?? prevExtras?.owner,
          approximatePresenceCount:
            partial.approximate_presence_count !== undefined
              ? partial.approximate_presence_count
              : prevExtras?.approximatePresenceCount,
        });
      }

      summaries.push(this.toGuildSummary(cached));
    }

    return summaries;
  }

  public hasHydratedGuildChannels(guildId: Snowflake): boolean {
    return this.hydratedGuildChannels.has(guildId);
  }

  public listGuildChannels(guildId: Snowflake): GuildChannelsResult | null {
    const guild = this.guilds.get(guildId);
    const seenIds = new Set<Snowflake>();
    const guildChannels: CachedChannel[] = [];

    if (guild !== undefined) {
      for (const channelId of guild.channelIds) {
        const ch = this.channels.get(channelId);
        if (ch !== undefined && !seenIds.has(ch.id)) {
          seenIds.add(ch.id);
          guildChannels.push(ch);
        }
      }
    }

    for (const ch of this.channels.values()) {
      if (ch.guildId === guildId && !seenIds.has(ch.id)) {
        seenIds.add(ch.id);
        guildChannels.push(ch);
      }
    }

    if (
      !this.hydratedGuildChannels.has(guildId) &&
      guildChannels.length === 0 &&
      (guild === undefined || guild.unavailable)
    ) {
      return null;
    }

    const categories: GuildChannelSummary[] = [];
    const channels: GuildChannelSummary[] = [];
    const threads: GuildChannelSummary[] = [];

    for (const ch of guildChannels) {
      const summary = toGuildChannelSummary(ch);
      if (summary.isCategory) {
        categories.push(summary);
      } else if (summary.isThread) {
        threads.push(summary);
      } else {
        channels.push(summary);
      }
    }

    categories.sort(compareGuildChannels);
    channels.sort(compareGuildChannels);
    threads.sort(compareGuildChannels);

    return {
      guildId,
      guildName: guild !== undefined && guild.name.length > 0 ? guild.name : null,
      totalChannels: categories.length + channels.length + threads.length,
      channels,
      categories,
      threads,
      source: "cache",
    };
  }

  public upsertGuildChannels(
    guildId: Snowflake,
    channels: readonly DiscordChannel[],
    threads?: readonly DiscordChannel[],
  ): void {
    const guild = this.guilds.get(guildId);
    const upsertedIds = new Set<Snowflake>();

    for (const ch of channels) {
      if (typeof ch?.id !== "string") {
        continue;
      }
      const normalized = this.upsertChannelInternal(
        ch.guild_id !== undefined ? ch : { ...ch, guild_id: guildId },
        true,
      );
      upsertedIds.add(normalized.id);
    }

    if (Array.isArray(threads)) {
      for (const thread of threads) {
        if (typeof thread?.id !== "string") {
          continue;
        }
        const normalized = this.upsertChannelInternal(
          thread.guild_id !== undefined ? thread : { ...thread, guild_id: guildId },
          true,
        );
        upsertedIds.add(normalized.id);
      }
    }

    if (guild !== undefined) {
      for (const oldChannelId of [...guild.channelIds]) {
        if (upsertedIds.has(oldChannelId)) {
          continue;
        }
        const existingChannel = this.channels.get(oldChannelId);
        const existingIsThread =
          existingChannel !== undefined &&
          isThreadChannelType(existingChannel.type);
        if (!existingIsThread || threads !== undefined) {
          this.removeChannelState(oldChannelId, true, guildId);
        }
      }
    }

    this.hydratedGuildChannels.add(guildId);
  }

  public extractChannelMembers(
    channelId: Snowflake,
    limit = DEFAULT_CHANNEL_MEMBERS_LIMIT,
  ): ChannelMemberSummary[] {
    if (!Number.isFinite(limit) || limit <= 0) {
      return [];
    }

    const channel = this.getChannel(channelId);
    const buffer = this.messagesByChannel.get(channelId);
    const seen = new Set<Snowflake>();
    const result: ChannelMemberSummary[] = [];

    const appendUser = (
      user: CachedUser,
      guildId: Snowflake | null,
    ): void => {
      if (seen.has(user.id) || result.length >= limit) {
        return;
      }
      seen.add(user.id);

      const guildMember =
        guildId !== null
          ? this.guildMembers.get(guildId)?.get(user.id)
          : undefined;

      result.push({
        userId: user.id,
        username: user.username,
        discriminator: user.discriminator,
        globalName: user.globalName,
        nickname: guildMember?.nickname ?? null,
        bot: user.bot,
        roleIds: guildMember !== undefined ? [...guildMember.roleIds] : [],
        joinedAt: guildMember?.joinedAt ?? null,
      });
    };

    if (buffer !== undefined) {
      for (let i = buffer.length - 1; i >= 0 && result.length < limit; i -= 1) {
        const msg = buffer[i]!;
        const freshUser = this.users.get(msg.author.id) ?? msg.author;
        const effectiveGuildId = channel?.guildId ?? msg.guildId ?? null;
        appendUser(freshUser, effectiveGuildId);
      }
    }

    if (channel !== null && channel.isDm) {
      for (const recipientId of channel.recipientIds) {
        if (result.length >= limit) {
          break;
        }
        const recipient = this.users.get(recipientId);
        if (recipient !== undefined) {
          appendUser(recipient, null);
        }
      }
    }

    return result;
  }

  public listDmChannels(): DmChannelSummary[] {
    const items: DmChannelSummary[] = [];
    for (const ch of this.dmChannels.values()) {
      items.push(this.toDmChannelSummary(ch));
    }
    items.sort((a, b) => {
      if (a.lastMessageId === null && b.lastMessageId === null) {
        return 0;
      }
      if (a.lastMessageId === null) {
        return 1;
      }
      if (b.lastMessageId === null) {
        return -1;
      }
      return compareSnowflakes(b.lastMessageId, a.lastMessageId);
    });
    return items;
  }

  public upsertDmChannels(
    channels: readonly DiscordChannel[],
  ): DmChannelSummary[] {
    const summaries: DmChannelSummary[] = [];
    for (const ch of channels) {
      if (typeof ch?.id !== "string") {
        continue;
      }
      const cached = this.upsertChannelInternal(ch, false);
      if (cached.isDm) {
        summaries.push(this.toDmChannelSummary(cached));
      }
    }
    return summaries;
  }

  public normalizeMessage(message: DiscordMessage): CachedMessage {
    const author = this.upsertUser(message.author);
    const mentionUsers = Array.isArray(message.mentions)
      ? message.mentions
      : [];
    const mentionUserIds: Snowflake[] = [];
    for (const mentioned of mentionUsers) {
      this.upsertUser(mentioned);
      mentionUserIds.push(mentioned.id);
    }

    const existingChannel = this.getChannel(message.channel_id);
    const guildId = message.guild_id ?? existingChannel?.guildId ?? null;
    const rawRecord = message as unknown as Record<string, unknown>;
    if (guildId !== null && isPlainRecord(rawRecord["member"])) {
      this.upsertGuildMemberFromPartial(
        guildId,
        author.id,
        rawRecord["member"],
      );
    }
    const isDm = existingChannel?.isDm ?? guildId === null;
    const mentionEveryone = Boolean(message.mention_everyone);
    const mentionRoleIds = Array.isArray(message.mention_roles)
      ? [...message.mention_roles]
      : [];

    const attachments: CachedAttachment[] = Array.isArray(message.attachments)
      ? message.attachments.map((att) => ({
          id: att.id,
          filename: att.filename,
          size: att.size,
          url: att.url,
          contentType: att.content_type ?? null,
        }))
      : [];

    const reactions: CachedReaction[] = Array.isArray(message.reactions)
      ? message.reactions.map((reaction) => normalizeDiscordReaction(reaction))
      : [];

    const mentionsBot = this.computeMentionsBot({
      guildId,
      isDm,
      mentionEveryone,
      mentionUserIds,
      mentionRoleIds,
    });

    return {
      id: message.id,
      channelId: message.channel_id,
      guildId,
      author,
      content: message.content ?? "",
      timestamp: message.timestamp,
      editedTimestamp: message.edited_timestamp ?? null,
      mentionsBot,
      mentionEveryone,
      mentionUserIds,
      mentionRoleIds,
      attachments,
      reactions,
      replyToMessageId: message.message_reference?.message_id ?? null,
    };
  }

  public handleGatewayDispatch(eventName: string, data: unknown): void {
    if (!isPlainRecord(data)) {
      return;
    }

    switch (eventName) {
      case "READY":
        this.handleReady(data as unknown as GatewayReadyData);
        break;
      case "RESUMED":
        break;
      case "GUILD_CREATE":
        this.handleGuildCreate(data as unknown as DiscordGuild);
        break;
      case "GUILD_UPDATE":
        this.handleGuildUpdate(data as unknown as DiscordGuild);
        break;
      case "GUILD_DELETE":
        this.handleGuildDelete(data as unknown as GatewayGuildDeleteData);
        break;
      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE":
      case "THREAD_CREATE":
      case "THREAD_UPDATE":
        this.upsertChannel(data as unknown as DiscordChannel);
        break;
      case "CHANNEL_DELETE":
      case "THREAD_DELETE": {
        const id = data["id"];
        if (typeof id === "string") {
          const guildId =
            typeof data["guild_id"] === "string" ? data["guild_id"] : undefined;
          this.removeChannelState(id, true, guildId);
        }
        break;
      }
      case "GUILD_MEMBER_ADD":
      case "GUILD_MEMBER_UPDATE": {
        const user = data["user"];
        const guildId = data["guild_id"];
        if (isPlainRecord(user) && typeof user["id"] === "string") {
          this.upsertUser(user as unknown as DiscordUser);
          if (typeof guildId === "string") {
            this.upsertGuildMemberFromPartial(guildId, user["id"], data);
          }
        }
        break;
      }
      case "GUILD_MEMBER_REMOVE": {
        const user = data["user"];
        const guildId = data["guild_id"];
        if (
          typeof guildId === "string" &&
          isPlainRecord(user) &&
          typeof user["id"] === "string"
        ) {
          this.guildMembers.get(guildId)?.delete(user["id"]);
        }
        break;
      }
      case "MESSAGE_CREATE":
        this.handleMessageCreate(data as unknown as DiscordMessage);
        break;
      case "MESSAGE_UPDATE":
        this.handleMessageUpdate(data as unknown as PartialDiscordMessageUpdate);
        break;
      case "MESSAGE_DELETE":
        this.handleMessageDelete(data as unknown as GatewayMessageDeleteData);
        break;
      case "MESSAGE_DELETE_BULK":
        this.handleMessageDeleteBulk(
          data as unknown as GatewayMessageDeleteBulkData,
        );
        break;
      case "MESSAGE_REACTION_ADD":
        this.handleReactionAdd(data as unknown as GatewayReactionAddData);
        break;
      case "MESSAGE_REACTION_REMOVE":
        this.handleReactionRemove(data as unknown as GatewayReactionRemoveData);
        break;
      case "MESSAGE_REACTION_REMOVE_ALL":
        this.handleReactionRemoveAll(
          data as unknown as GatewayReactionRemoveAllData,
        );
        break;
      case "MESSAGE_REACTION_REMOVE_EMOJI":
        this.handleReactionRemoveEmoji(
          data as unknown as GatewayReactionRemoveEmojiData,
        );
        break;
      case "USER_SETTINGS_UPDATE":
        this.upsertUserSettings(
          data as unknown as DiscordUserSettings,
          true,
        );
        break;
      case "RELATIONSHIP_ADD":
        this.upsertRelationship(data);
        break;
      case "RELATIONSHIP_REMOVE": {
        const id = data["id"];
        if (typeof id === "string") {
          this.relationships.delete(id);
        }
        break;
      }
      default:
        break;
    }
  }

  public emitGatewayState(
    state: GatewayConnectionState,
    detail: string | null,
  ): void {
    this.gatewayState = state;
    const timestamp = this.nowIso();
    for (const channelId of this.subscribersByChannel.keys()) {
      const event: WatchGatewayStateEvent = {
        type: WatchEventTypeValue.GATEWAY_STATE,
        timestamp,
        channelId,
        state,
        detail,
      };
      this.publishWatchEvent(channelId, event);
    }
  }

  public subscribeWatch(
    channelId: Snowflake,
    listener: (event: WatchEvent) => void,
    eventsFilter?: readonly WatchEventType[] | null,
    options?: WatchSubscribeOptions,
  ): () => void {
    const filter =
      eventsFilter !== undefined &&
      eventsFilter !== null &&
      eventsFilter.length > 0
        ? new Set(eventsFilter)
        : null;

    const subscription: WatchSubscription = {
      listener,
      filter,
    };

    let subs = this.subscribersByChannel.get(channelId);
    if (subs === undefined) {
      subs = new Set();
      this.subscribersByChannel.set(channelId, subs);
    }
    subs.add(subscription);

    if (options?.emitReady !== false) {
      const readyEvent: WatchReadyEvent = {
        type: WatchEventTypeValue.READY,
        timestamp: this.nowIso(),
        channelId,
        channel: this.getChannel(channelId),
        gatewayState: options?.gatewayState ?? this.gatewayState,
      };
      this.deliverToSubscription(subscription, readyEvent);
    }

    let unsubscribed = false;
    return () => {
      if (unsubscribed) {
        return;
      }
      unsubscribed = true;
      const currentSubs = this.subscribersByChannel.get(channelId);
      if (currentSubs === undefined) {
        return;
      }
      currentSubs.delete(subscription);
      if (currentSubs.size === 0) {
        this.subscribersByChannel.delete(channelId);
      }
    };
  }

  public getUnread(query: UnreadQuery = {}): UnreadResult {
    const includeDms = query.includeDms ?? true;
    const mentionsOnly = query.mentionsOnly ?? false;
    const items: UnreadRecord[] = [];

    for (const watermark of this.watermarks.values()) {
      if (watermark.unreadCount <= 0 || watermark.lastMessageId === null) {
        continue;
      }
      const channel = this.getChannel(watermark.channelId);
      const isDm = channel?.isDm ?? false;
      if (!includeDms && isDm) {
        continue;
      }
      if (mentionsOnly && watermark.mentionCount <= 0) {
        continue;
      }

      const guildName =
        channel?.guildId !== null && channel?.guildId !== undefined
          ? (this.guilds.get(channel.guildId)?.name ?? null)
          : null;
      const latestMsg = this.resolveLatestMessageForChannel(watermark.channelId);

      items.push({
        channelId: watermark.channelId,
        channelName: channel?.name ?? watermark.channelId,
        guildId: channel?.guildId ?? null,
        guildName,
        isDm,
        lastReadMessageId: watermark.lastReadMessageId,
        lastMessageId: watermark.lastMessageId,
        unreadCount: watermark.unreadCount,
        mentionCount: watermark.mentionCount,
        hasMention: watermark.mentionCount > 0,
        latestMessageTimestamp: latestMsg?.timestamp ?? watermark.updatedAt,
        latestMessagePreview:
          latestMsg !== undefined ? formatMessagePreview(latestMsg) : "",
        latestAuthorName:
          latestMsg !== undefined
            ? (latestMsg.author.globalName ?? latestMsg.author.username)
            : "",
      });
    }

    items.sort((a, b) => compareSnowflakes(b.lastMessageId, a.lastMessageId));

    let totalUnreadMessages = 0;
    let totalMentions = 0;
    for (const item of items) {
      totalUnreadMessages += item.unreadCount;
      totalMentions += item.mentionCount;
    }

    return {
      totalUnreadChannels: items.length,
      totalUnreadMessages,
      totalMentions,
      items,
    };
  }

  public getCachedMessages(
    channelId: Snowflake,
    opts: GetCachedMessagesOptions = {},
  ): CachedMessage[] {
    const buffer = this.messagesByChannel.get(channelId);
    if (buffer === undefined || buffer.length === 0) {
      return [];
    }

    let filtered = buffer;
    if (opts.before !== undefined) {
      const beforeId = opts.before;
      filtered = filtered.filter(
        (msg) => compareSnowflakes(msg.id, beforeId) < 0,
      );
    }
    if (opts.after !== undefined) {
      const afterId = opts.after;
      filtered = filtered.filter(
        (msg) => compareSnowflakes(msg.id, afterId) > 0,
      );
    }

    if (opts.limit !== undefined) {
      if (opts.limit <= 0) {
        return [];
      }
      if (opts.after !== undefined && opts.before === undefined) {
        return filtered.slice(0, opts.limit);
      }
      return filtered.slice(-opts.limit);
    }

    return [...filtered];
  }

  public canServeLatestFromCache(channelId: Snowflake, limit: number): boolean {
    if (limit <= 0 || !this.restHydratedChannels.has(channelId)) {
      return false;
    }
    const buffer = this.messagesByChannel.get(channelId);
    return buffer !== undefined && buffer.length >= limit;
  }

  public mergeRestTailMessages(
    channelId: Snowflake,
    messages: readonly DiscordMessage[],
  ): CachedMessage[] {
    return this.mergeRestMessages(channelId, messages, true);
  }

  public mergeRestMessages(
    channelId: Snowflake,
    messages: readonly DiscordMessage[],
    isLatestTail: boolean,
  ): CachedMessage[] {
    const dedupedIncoming = new Map<Snowflake, CachedMessage>();
    for (const raw of messages) {
      const normalized = this.normalizeMessage(raw);
      dedupedIncoming.set(normalized.id, normalized);
    }

    const normalizedSorted = Array.from(dedupedIncoming.values()).sort((a, b) =>
      compareSnowflakes(a.id, b.id),
    );

    if (!isLatestTail) {
      return normalizedSorted;
    }

    const mergedById = new Map<Snowflake, CachedMessage>();
    const existingBuffer = this.messagesByChannel.get(channelId);
    if (existingBuffer !== undefined) {
      for (const existing of existingBuffer) {
        mergedById.set(existing.id, existing);
      }
    }
    for (const incoming of normalizedSorted) {
      mergedById.set(incoming.id, incoming);
    }

    let mergedSorted = Array.from(mergedById.values()).sort((a, b) =>
      compareSnowflakes(a.id, b.id),
    );
    if (mergedSorted.length > this.maxMessagesPerChannel) {
      mergedSorted = mergedSorted.slice(
        mergedSorted.length - this.maxMessagesPerChannel,
      );
    }

    this.messagesByChannel.set(channelId, mergedSorted);
    this.restHydratedChannels.add(channelId);

    if (mergedSorted.length > 0) {
      const newest = mergedSorted[mergedSorted.length - 1]!;
      const channel = this.getChannel(channelId);
      if (channel !== null) {
        channel.lastMessageId = maxSnowflake(channel.lastMessageId, newest.id);
        channel.updatedAt = this.nowIso();
      }
      const existingMeta = this.latestMessageMetaByChannel.get(channelId);
      if (
        existingMeta === undefined ||
        compareSnowflakes(newest.id, existingMeta.id) >= 0
      ) {
        this.latestMessageMetaByChannel.set(channelId, newest);
      }
      const watermark = this.watermarks.get(channelId);
      if (watermark !== undefined) {
        watermark.lastMessageId = maxSnowflake(
          watermark.lastMessageId,
          newest.id,
        );
        watermark.updatedAt = this.nowIso();
      }
    }

    return normalizedSorted;
  }

  public markChannelRead(
    channelId: Snowflake,
    upToMessageId?: Snowflake,
  ): Snowflake | null {
    const buffer = this.messagesByChannel.get(channelId);
    const newestCachedId =
      buffer !== undefined && buffer.length > 0
        ? buffer[buffer.length - 1]!.id
        : null;
    const existingWatermark = this.watermarks.get(channelId);
    const channel = this.getChannel(channelId);

    let targetId =
      upToMessageId ??
      maxSnowflake(
        newestCachedId,
        maxSnowflake(
          existingWatermark?.lastMessageId ?? null,
          channel?.lastMessageId ?? null,
        ),
      );

    if (targetId === null) {
      if (existingWatermark !== undefined) {
        existingWatermark.unreadCount = 0;
        existingWatermark.mentionCount = 0;
        existingWatermark.updatedAt = this.nowIso();
        return existingWatermark.lastReadMessageId;
      }
      return null;
    }

    const nowIso = this.nowIso();
    let watermark = existingWatermark;
    if (watermark === undefined) {
      watermark = {
        channelId,
        lastReadMessageId: targetId,
        lastMessageId: maxSnowflake(targetId, channel?.lastMessageId ?? null),
        unreadCount: 0,
        mentionCount: 0,
        updatedAt: nowIso,
      };
      this.watermarks.set(channelId, watermark);
      return watermark.lastReadMessageId;
    }

    const effectiveReadId = maxSnowflake(watermark.lastReadMessageId, targetId)!;
    watermark.lastReadMessageId = effectiveReadId;
    watermark.lastMessageId = maxSnowflake(watermark.lastMessageId, effectiveReadId);
    watermark.updatedAt = nowIso;

    if (
      watermark.lastMessageId === null ||
      compareSnowflakes(effectiveReadId, watermark.lastMessageId) >= 0
    ) {
      watermark.unreadCount = 0;
      watermark.mentionCount = 0;
    } else if (
      buffer !== undefined &&
      (buffer.length === 0 ||
        compareSnowflakes(buffer[0]!.id, effectiveReadId) <= 0)
    ) {
      let unreadCount = 0;
      let mentionCount = 0;
      for (const msg of buffer) {
        if (
          compareSnowflakes(msg.id, effectiveReadId) > 0 &&
          (this.botUser === null || msg.author.id !== this.botUser.id)
        ) {
          unreadCount += 1;
          if (msg.mentionsBot) {
            mentionCount += 1;
          }
        }
      }
      watermark.unreadCount = unreadCount;
      watermark.mentionCount = mentionCount;
    }

    return watermark.lastReadMessageId;
  }

  public getCacheSnapshot(): CacheStatusSnapshot {
    let cachedMessages = 0;
    for (const buffer of this.messagesByChannel.values()) {
      cachedMessages += buffer.length;
    }

    let unreadChannels = 0;
    let totalUnreadMessages = 0;
    let totalMentions = 0;
    for (const watermark of this.watermarks.values()) {
      if (watermark.unreadCount > 0 && watermark.lastMessageId !== null) {
        unreadChannels += 1;
        totalUnreadMessages += watermark.unreadCount;
        totalMentions += watermark.mentionCount;
      }
    }

    let activeWatchers = 0;
    for (const subs of this.subscribersByChannel.values()) {
      activeWatchers += subs.size;
    }

    return {
      guilds: this.guilds.size,
      channels: this.channels.size,
      dmChannels: this.dmChannels.size,
      users: this.users.size,
      cachedMessages,
      unreadChannels,
      totalUnreadMessages,
      totalMentions,
      activeWatchers,
    };
  }

  private upsertRelationship(raw: unknown): void {
    if (!isPlainRecord(raw) || typeof raw["id"] !== "string") {
      return;
    }
    if (isPlainRecord(raw["user"]) && typeof raw["user"]["id"] === "string") {
      this.upsertUser(raw["user"] as unknown as DiscordUser);
    }
    if (typeof raw["type"] === "number") {
      const typedRel = raw as unknown as DiscordRelationship;
      this.relationships.set(typedRel.id, {
        ...typedRel,
        ...(typedRel.user !== undefined
          ? { user: { ...typedRel.user } }
          : {}),
      });
    }
  }

  private upsertUserSettings(
    raw: DiscordUserSettings,
    merge: boolean,
  ): void {
    const base: DiscordUserSettings =
      merge && this.userSettings !== null ? { ...this.userSettings } : {};
    const next: DiscordUserSettings = { ...base, ...raw };
    if (isPlainRecord(raw.custom_status)) {
      next.custom_status = { ...raw.custom_status };
    } else if (raw.custom_status === null) {
      next.custom_status = null;
    }
    this.userSettings = next;
  }

  private handleReady(ready: GatewayReadyData): void {
    const hadSession = this.botUser !== null;
    if (ready.user !== undefined) {
      this.botUser = this.upsertUser(ready.user);
    }
    if (hadSession) {
      this.restHydratedChannels.clear();
    }

    this.guilds.clear();
    this.channels.clear();
    this.guildMembers.clear();
    this.relationships.clear();
    this.hydratedGuildChannels.clear();
    this.guildExtras.clear();
    this.userSettings = null;

    if (Array.isArray(ready.users)) {
      for (const user of ready.users) {
        if (isPlainRecord(user) && typeof user["id"] === "string") {
          this.upsertUser(user as unknown as DiscordUser);
        }
      }
    }

    if (Array.isArray(ready.relationships)) {
      for (const rel of ready.relationships) {
        this.upsertRelationship(rel);
      }
    }

    if (isPlainRecord(ready.user_settings)) {
      this.upsertUserSettings(
        ready.user_settings as unknown as DiscordUserSettings,
        false,
      );
    }

    if (Array.isArray(ready.private_channels)) {
      for (const dm of ready.private_channels) {
        if (isPlainRecord(dm) && typeof dm["id"] === "string") {
          this.upsertChannelInternal(dm as unknown as DiscordChannel, false);
        }
      }
    }

    const nowIso = this.nowIso();
    const readyGuilds = Array.isArray(ready.guilds) ? ready.guilds : [];
    const mergedMembersList = Array.isArray(ready.merged_members)
      ? ready.merged_members
      : [];

    for (let i = 0; i < readyGuilds.length; i += 1) {
      const rawGuild = readyGuilds[i];
      if (!isPlainRecord(rawGuild) || typeof rawGuild["id"] !== "string") {
        continue;
      }

      const guild = rawGuild as unknown as
        | DiscordUnavailableGuild
        | DiscordGuild
        | DiscordUserReadyGuild;
      const guildMergedMembers = Array.isArray(mergedMembersList[i])
        ? mergedMembersList[i]
        : undefined;

      if (guild.unavailable === true) {
        let botRoleIds: Snowflake[] = [];
        if (guildMergedMembers !== undefined) {
          const botMember = this.hydrateGuildMembers(
            guild.id,
            guildMergedMembers,
            true,
          );
          if (botMember !== null) {
            botRoleIds = [...botMember.roles];
          }
        }
        this.guilds.set(guild.id, {
          id: guild.id,
          name: "",
          icon: null,
          ownerId: "",
          unavailable: true,
          memberCount: null,
          botRoleIds,
          channelIds: [],
          updatedAt: nowIso,
        });
        continue;
      }

      const readyGuild = guild as DiscordUserReadyGuild;
      const hasHydratedData =
        readyGuild.name !== undefined ||
        readyGuild.properties !== undefined ||
        Array.isArray(readyGuild.channels) ||
        Array.isArray(readyGuild.threads) ||
        Array.isArray(readyGuild.members);

      if (hasHydratedData) {
        this.hydrateGuild(readyGuild, guildMergedMembers);
      } else {
        let botRoleIds: Snowflake[] = [];
        if (guildMergedMembers !== undefined) {
          const botMember = this.hydrateGuildMembers(
            guild.id,
            guildMergedMembers,
            true,
          );
          if (botMember !== null) {
            botRoleIds = [...botMember.roles];
          }
        }
        this.guilds.set(guild.id, {
          id: guild.id,
          name: "",
          icon: null,
          ownerId: "",
          unavailable: guild.unavailable ?? true,
          memberCount: null,
          botRoleIds,
          channelIds: [],
          updatedAt: nowIso,
        });
      }
    }
  }

  private handleGuildCreate(guild: DiscordGuild): void {
    this.hydrateGuild(guild);
  }

  private hydrateGuild(
    guild: DiscordGuild | DiscordUserReadyGuild,
    extraMembers?: readonly DiscordGuildMember[],
  ): void {
    const existing = this.guilds.get(guild.id);
    const nowIso = this.nowIso();

    let botRoleIds: Snowflake[] = existing?.botRoleIds ?? [];
    if (Array.isArray(guild.members)) {
      const botMember = this.hydrateGuildMembers(guild.id, guild.members, false);
      if (botMember !== null) {
        botRoleIds = [...botMember.roles];
      }
    }
    if (Array.isArray(extraMembers)) {
      const botMember = this.hydrateGuildMembers(guild.id, extraMembers, true);
      if (botMember !== null) {
        botRoleIds = [...botMember.roles];
      }
    }

    const hasChannelsField = Array.isArray(guild.channels);
    const hasThreadsField = Array.isArray(guild.threads);
    const channelIdSet = new Set<Snowflake>();

    if (hasChannelsField) {
      for (const ch of guild.channels!) {
        const normalized = this.upsertChannelInternal(
          ch.guild_id !== undefined ? ch : { ...ch, guild_id: guild.id },
          false,
        );
        channelIdSet.add(normalized.id);
      }
    }
    if (hasThreadsField) {
      for (const thread of guild.threads!) {
        const normalized = this.upsertChannelInternal(
          thread.guild_id !== undefined
            ? thread
            : { ...thread, guild_id: guild.id },
          false,
        );
        channelIdSet.add(normalized.id);
      }
    }

    if (channelIdSet.size > 0) {
      this.hydratedGuildChannels.add(guild.id);
    }

    if (existing !== undefined && hasChannelsField) {
      for (const oldChannelId of existing.channelIds) {
        if (!channelIdSet.has(oldChannelId)) {
          this.removeChannelState(oldChannelId, false);
        }
      }
    }

    const resolvedName =
      guild.properties?.name ?? guild.name ?? existing?.name ?? "";
    const resolvedOwnerId =
      guild.properties?.owner_id ?? guild.owner_id ?? existing?.ownerId ?? "";
    const resolvedIcon =
      guild.properties?.icon !== undefined
        ? guild.properties.icon
        : guild.icon !== undefined
          ? guild.icon
          : (existing?.icon ?? null);

    const cachedGuild: CachedGuild = {
      id: guild.id,
      name: resolvedName,
      icon: resolvedIcon,
      ownerId: resolvedOwnerId,
      unavailable: guild.unavailable === true,
      memberCount: guild.member_count ?? existing?.memberCount ?? null,
      botRoleIds,
      channelIds:
        hasChannelsField || hasThreadsField
          ? Array.from(channelIdSet)
          : [...(existing?.channelIds ?? [])],
      updatedAt: nowIso,
    };

    this.guilds.set(guild.id, cachedGuild);
  }

  private handleGuildUpdate(guild: DiscordGuild): void {
    const existing = this.guilds.get(guild.id);
    const nowIso = this.nowIso();

    let botRoleIds = existing?.botRoleIds ?? [];
    if (Array.isArray(guild.members)) {
      const botMember = this.hydrateGuildMembers(guild.id, guild.members, false);
      if (botMember !== null) {
        botRoleIds = [...botMember.roles];
      }
    }

    const resolvedName =
      guild.properties?.name ?? guild.name ?? existing?.name ?? "";
    const resolvedOwnerId =
      guild.properties?.owner_id ?? guild.owner_id ?? existing?.ownerId ?? "";
    const resolvedIcon =
      guild.properties?.icon !== undefined
        ? guild.properties.icon
        : guild.icon !== undefined
          ? guild.icon
          : (existing?.icon ?? null);

    const updatedGuild: CachedGuild = {
      id: guild.id,
      name: resolvedName,
      icon: resolvedIcon,
      ownerId: resolvedOwnerId,
      unavailable: guild.unavailable === true,
      memberCount: guild.member_count ?? existing?.memberCount ?? null,
      botRoleIds,
      channelIds: [...(existing?.channelIds ?? [])],
      updatedAt: nowIso,
    };

    this.guilds.set(guild.id, updatedGuild);
  }

  private handleGuildDelete(payload: GatewayGuildDeleteData): void {
    const existing = this.guilds.get(payload.id);
    const nowIso = this.nowIso();

    if (payload.unavailable === true) {
      if (existing !== undefined) {
        existing.unavailable = true;
        existing.updatedAt = nowIso;
      } else {
        this.guilds.set(payload.id, {
          id: payload.id,
          name: "",
          icon: null,
          ownerId: "",
          unavailable: true,
          memberCount: null,
          botRoleIds: [],
          channelIds: [],
          updatedAt: nowIso,
        });
      }
      return;
    }

    this.guilds.delete(payload.id);
    this.guildMembers.delete(payload.id);
    this.hydratedGuildChannels.delete(payload.id);
    this.guildExtras.delete(payload.id);

    const channelsToRemove = new Set<Snowflake>(existing?.channelIds ?? []);
    for (const [channelId, channel] of this.channels.entries()) {
      if (channel.guildId === payload.id) {
        channelsToRemove.add(channelId);
      }
    }
    for (const channelId of channelsToRemove) {
      this.removeChannelState(channelId, false);
    }
  }

  private toGuildSummary(guild: CachedGuild): GuildSummary {
    const extras = this.guildExtras.get(guild.id);
    const owner =
      extras?.owner !== undefined
        ? extras.owner
        : this.botUser !== null && guild.ownerId.length > 0
          ? guild.ownerId === this.botUser.id
          : undefined;
    const summary: GuildSummary = {
      id: guild.id,
      name: guild.name,
      icon: guild.icon ?? null,
      ownerId: guild.ownerId.length > 0 ? guild.ownerId : null,
      memberCount: guild.memberCount,
      unavailable: guild.unavailable,
    };
    if (owner !== undefined) {
      summary.owner = owner;
    }
    if (extras?.approximatePresenceCount !== undefined) {
      summary.approximatePresenceCount = extras.approximatePresenceCount;
    }
    return summary;
  }

  private toDmChannelSummary(ch: CachedChannel): DmChannelSummary {
    const recipients: DmRecipientSummary[] = [];
    for (const rid of ch.recipientIds) {
      const user = this.users.get(rid);
      if (user !== undefined) {
        recipients.push({
          id: user.id,
          username: user.username,
          discriminator: user.discriminator,
          globalName: user.globalName,
          bot: user.bot,
        });
      }
    }
    const primaryRecipientId = ch.recipientIds[0] ?? null;
    const primaryUser =
      primaryRecipientId !== null
        ? this.users.get(primaryRecipientId)
        : undefined;
    return {
      channelId: ch.id,
      type: ch.type,
      name: ch.name,
      recipientId: primaryRecipientId,
      recipientIds: [...ch.recipientIds],
      username: primaryUser?.username ?? null,
      globalName: primaryUser?.globalName ?? null,
      recipients,
      lastMessageId: ch.lastMessageId,
    };
  }

  private upsertGuildMember(
    guildId: Snowflake,
    userId: Snowflake,
    data: {
      nickname?: string | null;
      roleIds?: readonly Snowflake[];
      joinedAt?: IsoTimestamp | null;
    },
  ): CachedGuildMember {
    let membersByUser = this.guildMembers.get(guildId);
    if (membersByUser === undefined) {
      membersByUser = new Map();
      this.guildMembers.set(guildId, membersByUser);
    }
    const existing = membersByUser.get(userId);
    const cached: CachedGuildMember = {
      userId,
      guildId,
      nickname:
        data.nickname !== undefined
          ? data.nickname
          : (existing?.nickname ?? null),
      roleIds:
        data.roleIds !== undefined
          ? [...data.roleIds]
          : [...(existing?.roleIds ?? [])],
      joinedAt:
        data.joinedAt !== undefined
          ? data.joinedAt
          : (existing?.joinedAt ?? null),
      updatedAt: this.nowIso(),
    };
    membersByUser.set(userId, cached);
    return cached;
  }

  private upsertGuildMemberFromPartial(
    guildId: Snowflake,
    userId: Snowflake,
    memberRaw: Record<string, unknown>,
  ): void {
    const nickname =
      typeof memberRaw["nick"] === "string"
        ? memberRaw["nick"]
        : memberRaw["nick"] === null
          ? null
          : undefined;
    const roleIds = Array.isArray(memberRaw["roles"])
      ? memberRaw["roles"].filter((r): r is Snowflake => typeof r === "string")
      : undefined;
    const joinedAt =
      typeof memberRaw["joined_at"] === "string"
        ? memberRaw["joined_at"]
        : memberRaw["joined_at"] === null
          ? null
          : undefined;

    this.upsertGuildMember(guildId, userId, {
      nickname,
      roleIds,
      joinedAt,
    });

    if (
      this.botUser !== null &&
      userId === this.botUser.id &&
      roleIds !== undefined
    ) {
      const guild = this.guilds.get(guildId);
      if (guild !== undefined) {
        guild.botRoleIds = [...roleIds];
        guild.updatedAt = this.nowIso();
      }
    }
  }

  private hydrateGuildMembers(
    guildId: Snowflake,
    members: readonly DiscordGuildMember[],
    allowSingleSelfFallback: boolean,
  ): { userId: Snowflake; roles: Snowflake[] } | null {
    let botMember: { userId: Snowflake; roles: Snowflake[] } | null = null;
    for (const member of members) {
      if (!isPlainRecord(member)) {
        continue;
      }
      const rawMember = member as unknown as Record<string, unknown>;
      let userId: Snowflake | undefined;
      if (
        isPlainRecord(rawMember["user"]) &&
        typeof rawMember["user"]["id"] === "string"
      ) {
        const cachedUser = this.upsertUser(
          rawMember["user"] as unknown as DiscordUser,
        );
        userId = cachedUser.id;
      } else if (typeof rawMember["user_id"] === "string") {
        userId = rawMember["user_id"];
      } else if (
        allowSingleSelfFallback &&
        members.length === 1 &&
        this.botUser !== null
      ) {
        userId = this.botUser.id;
      }

      if (userId === undefined) {
        continue;
      }

      const roleIds = Array.isArray(rawMember["roles"])
        ? rawMember["roles"].filter((r): r is Snowflake => typeof r === "string")
        : [];
      const nickname =
        typeof rawMember["nick"] === "string"
          ? rawMember["nick"]
          : rawMember["nick"] === null
            ? null
            : undefined;
      const joinedAt =
        typeof rawMember["joined_at"] === "string"
          ? rawMember["joined_at"]
          : rawMember["joined_at"] === null
            ? null
            : undefined;

      this.upsertGuildMember(guildId, userId, {
        nickname,
        roleIds: Array.isArray(rawMember["roles"]) ? roleIds : undefined,
        joinedAt,
      });

      if (this.botUser !== null && userId === this.botUser.id) {
        botMember = { userId, roles: roleIds };
      }
    }
    return botMember;
  }

  private upsertChannelInternal(
    channel: DiscordChannel,
    attachToGuild: boolean,
  ): CachedChannel {
    const existing = this.getChannel(channel.id);
    const isDm = isDmChannelPayload(channel);
    const nowIso = this.nowIso();

    let recipientIds: Snowflake[] = existing?.recipientIds ?? [];
    const recipientUsers: CachedUser[] = [];
    if (Array.isArray(channel.recipients)) {
      recipientIds = [];
      for (const recipient of channel.recipients) {
        const cachedRecipient = this.upsertUser(recipient);
        recipientIds.push(cachedRecipient.id);
        recipientUsers.push(cachedRecipient);
      }
    } else {
      const rawRecipientIds = (channel as unknown as { recipient_ids?: unknown })
        .recipient_ids;
      if (Array.isArray(rawRecipientIds)) {
        recipientIds = [];
        for (const rawId of rawRecipientIds) {
          if (typeof rawId === "string" && rawId.length > 0) {
            recipientIds.push(rawId);
            const cachedRecipient = this.users.get(rawId);
            if (cachedRecipient !== undefined) {
              recipientUsers.push(cachedRecipient);
            }
          }
        }
      } else if (existing !== null) {
        for (const rid of existing.recipientIds) {
          const cachedRecipient = this.users.get(rid);
          if (cachedRecipient !== undefined) {
            recipientUsers.push(cachedRecipient);
          }
        }
      }
    }

    const name = this.resolveChannelName(
      channel,
      existing,
      isDm,
      recipientUsers,
    );
    const guildId = isDm ? null : (channel.guild_id ?? existing?.guildId ?? null);
    const lastMessageId = maxSnowflake(
      existing?.lastMessageId ?? null,
      channel.last_message_id ?? null,
    );
    const position =
      channel.position !== undefined
        ? channel.position
        : (existing?.position ?? null);
    const nsfw =
      channel.nsfw !== undefined ? Boolean(channel.nsfw) : existing?.nsfw;

    const cached: CachedChannel = {
      id: channel.id,
      type: channel.type,
      guildId,
      name,
      topic:
        channel.topic !== undefined ? channel.topic : (existing?.topic ?? null),
      parentId:
        channel.parent_id !== undefined
          ? channel.parent_id
          : (existing?.parentId ?? null),
      position,
      ...(nsfw !== undefined ? { nsfw } : {}),
      recipientIds,
      lastMessageId,
      isDm,
      updatedAt: nowIso,
    };

    if (isDm) {
      this.dmChannels.set(cached.id, cached);
      this.channels.delete(cached.id);
    } else {
      this.channels.set(cached.id, cached);
      this.dmChannels.delete(cached.id);
      if (attachToGuild && cached.guildId !== null) {
        const guild = this.guilds.get(cached.guildId);
        if (guild !== undefined && !guild.channelIds.includes(cached.id)) {
          guild.channelIds.push(cached.id);
          guild.updatedAt = nowIso;
        }
      }
    }

    return cached;
  }

  private resolveChannelName(
    channel: DiscordChannel,
    existing: CachedChannel | null,
    isDm: boolean,
    recipientUsers: readonly CachedUser[],
  ): string {
    if (typeof channel.name === "string" && channel.name.trim().length > 0) {
      return channel.name;
    }
    if (isDm && recipientUsers.length > 0) {
      return recipientUsers
        .map((user) => user.globalName ?? user.username)
        .join(", ");
    }
    if (existing !== null && existing.name.length > 0) {
      return existing.name;
    }
    return isDm ? `dm-${channel.id}` : channel.id;
  }

  private removeChannelState(
    channelId: Snowflake,
    detachFromGuild: boolean,
    guildIdHint?: Snowflake,
  ): void {
    const existing = this.getChannel(channelId);
    this.channels.delete(channelId);
    this.dmChannels.delete(channelId);
    this.messagesByChannel.delete(channelId);
    this.watermarks.delete(channelId);
    this.latestMessageMetaByChannel.delete(channelId);
    this.restHydratedChannels.delete(channelId);

    if (detachFromGuild) {
      const guildId = guildIdHint ?? existing?.guildId ?? null;
      if (guildId !== null) {
        const guild = this.guilds.get(guildId);
        if (guild !== undefined) {
          const idx = guild.channelIds.indexOf(channelId);
          if (idx !== -1) {
            guild.channelIds.splice(idx, 1);
            guild.updatedAt = this.nowIso();
          }
        }
      }
    }
  }

  private handleMessageCreate(raw: DiscordMessage): void {
    if (
      typeof raw.id !== "string" ||
      typeof raw.channel_id !== "string" ||
      !isPlainRecord(raw.author) ||
      typeof raw.author["id"] !== "string"
    ) {
      return;
    }

    const nowIso = this.nowIso();

    if (
      raw.guild_id === undefined &&
      !this.channels.has(raw.channel_id) &&
      !this.dmChannels.has(raw.channel_id)
    ) {
      const authorCached = this.upsertUser(raw.author);
      const isSelfAuthor =
        this.botUser !== null && authorCached.id === this.botUser.id;
      const stubName = isSelfAuthor
        ? `dm-${raw.channel_id}`
        : (authorCached.globalName ?? authorCached.username);
      const dmStub: CachedChannel = {
        id: raw.channel_id,
        type: DiscordChannelType.DM,
        guildId: null,
        name: stubName,
        topic: null,
        parentId: null,
        recipientIds: isSelfAuthor ? [] : [authorCached.id],
        lastMessageId: raw.id,
        isDm: true,
        updatedAt: nowIso,
      };
      this.dmChannels.set(dmStub.id, dmStub);
    }

    const message = this.normalizeMessage(raw);
    const alreadyCached = this.insertMessageIntoBuffer(message);

    const channel = this.getChannel(message.channelId);
    if (channel !== null) {
      channel.lastMessageId = maxSnowflake(channel.lastMessageId, message.id);
      channel.updatedAt = nowIso;
    }

    const existingMeta = this.latestMessageMetaByChannel.get(message.channelId);
    if (
      existingMeta === undefined ||
      compareSnowflakes(message.id, existingMeta.id) >= 0
    ) {
      this.latestMessageMetaByChannel.set(message.channelId, message);
    }

    let watermark = this.watermarks.get(message.channelId);
    if (watermark === undefined) {
      watermark = {
        channelId: message.channelId,
        lastReadMessageId: null,
        lastMessageId: message.id,
        unreadCount: 0,
        mentionCount: 0,
        updatedAt: nowIso,
      };
      this.watermarks.set(message.channelId, watermark);
    } else {
      watermark.lastMessageId = maxSnowflake(watermark.lastMessageId, message.id);
      watermark.updatedAt = nowIso;
    }

    const isSelfAuthor =
      this.botUser !== null && message.author.id === this.botUser.id;
    const isAfterLastRead =
      watermark.lastReadMessageId === null ||
      compareSnowflakes(message.id, watermark.lastReadMessageId) > 0;

    if (!alreadyCached && !isSelfAuthor && isAfterLastRead) {
      watermark.unreadCount += 1;
      if (message.mentionsBot) {
        watermark.mentionCount += 1;
      }
    }

    const event: WatchMessageCreateEvent = {
      type: WatchEventTypeValue.MESSAGE_CREATE,
      timestamp: nowIso,
      channelId: message.channelId,
      message,
    };
    this.publishWatchEvent(message.channelId, event);
  }

  private handleMessageUpdate(raw: PartialDiscordMessageUpdate): void {
    if (typeof raw.id !== "string" || typeof raw.channel_id !== "string") {
      return;
    }

    if (raw.author !== undefined && typeof raw.author.id === "string") {
      this.upsertUser(raw.author);
    }
    if (Array.isArray(raw.mentions)) {
      for (const user of raw.mentions) {
        if (typeof user.id === "string") {
          this.upsertUser(user);
        }
      }
    }

    const buffer = this.messagesByChannel.get(raw.channel_id);
    const cached = buffer?.find((msg) => msg.id === raw.id);
    const nowIso = this.nowIso();

    const rawRecord = raw as unknown as Record<string, unknown>;
    const memberGuildId =
      raw.guild_id ??
      cached?.guildId ??
      this.getChannel(raw.channel_id)?.guildId ??
      null;
    const memberUserId = raw.author?.id ?? cached?.author.id;
    if (
      memberGuildId !== null &&
      memberUserId !== undefined &&
      isPlainRecord(rawRecord["member"])
    ) {
      this.upsertGuildMemberFromPartial(
        memberGuildId,
        memberUserId,
        rawRecord["member"],
      );
    }

    if (cached !== undefined) {
      const wasMentionsBot = cached.mentionsBot;

      if (raw.guild_id !== undefined) {
        cached.guildId = raw.guild_id;
      }
      if (raw.author !== undefined && typeof raw.author.id === "string") {
        cached.author = this.upsertUser(raw.author);
      }
      if (raw.content !== undefined) {
        cached.content = raw.content;
      }
      if (raw.timestamp !== undefined) {
        cached.timestamp = raw.timestamp;
      }
      if (raw.edited_timestamp !== undefined) {
        cached.editedTimestamp = raw.edited_timestamp;
      }
      if (raw.mention_everyone !== undefined) {
        cached.mentionEveryone = Boolean(raw.mention_everyone);
      }
      if (Array.isArray(raw.mentions)) {
        cached.mentionUserIds = raw.mentions.map((u) => u.id);
      }
      if (Array.isArray(raw.mention_roles)) {
        cached.mentionRoleIds = [...raw.mention_roles];
      }
      if (Array.isArray(raw.attachments)) {
        cached.attachments = raw.attachments.map((att) => ({
          id: att.id,
          filename: att.filename,
          size: att.size,
          url: att.url,
          contentType: att.content_type ?? null,
        }));
      }
      if (Array.isArray(raw.reactions)) {
        cached.reactions = raw.reactions.map((r) => normalizeDiscordReaction(r));
      }
      if (raw.message_reference !== undefined) {
        cached.replyToMessageId = raw.message_reference?.message_id ?? null;
      }

      const channel = this.getChannel(cached.channelId);
      const isDm = channel?.isDm ?? cached.guildId === null;
      cached.mentionsBot = this.computeMentionsBot({
        guildId: cached.guildId,
        isDm,
        mentionEveryone: cached.mentionEveryone,
        mentionUserIds: cached.mentionUserIds,
        mentionRoleIds: cached.mentionRoleIds,
      });

      const meta = this.latestMessageMetaByChannel.get(cached.channelId);
      if (meta !== undefined && meta.id === cached.id) {
        this.latestMessageMetaByChannel.set(cached.channelId, cached);
      }

      const watermark = this.watermarks.get(cached.channelId);
      if (
        watermark !== undefined &&
        (this.botUser === null || cached.author.id !== this.botUser.id) &&
        (watermark.lastReadMessageId === null ||
          compareSnowflakes(cached.id, watermark.lastReadMessageId) > 0)
      ) {
        if (!wasMentionsBot && cached.mentionsBot) {
          watermark.mentionCount += 1;
          watermark.updatedAt = nowIso;
        } else if (wasMentionsBot && !cached.mentionsBot) {
          watermark.mentionCount = Math.max(0, watermark.mentionCount - 1);
          watermark.updatedAt = nowIso;
        }
      }

      const event: WatchMessageUpdateEvent = {
        type: WatchEventTypeValue.MESSAGE_UPDATE,
        timestamp: nowIso,
        channelId: cached.channelId,
        message: cached,
      };
      this.publishWatchEvent(cached.channelId, event);
      return;
    }

    if (
      raw.author !== undefined &&
      typeof raw.author.id === "string" &&
      typeof raw.author.username === "string" &&
      typeof raw.content === "string" &&
      typeof raw.timestamp === "string"
    ) {
      const normalized = this.normalizeMessage(raw as DiscordMessage);
      const event: WatchMessageUpdateEvent = {
        type: WatchEventTypeValue.MESSAGE_UPDATE,
        timestamp: nowIso,
        channelId: normalized.channelId,
        message: normalized,
      };
      this.publishWatchEvent(normalized.channelId, event);
    }
  }

  private handleMessageDelete(data: GatewayMessageDeleteData): void {
    if (typeof data.id !== "string" || typeof data.channel_id !== "string") {
      return;
    }
    this.deleteMessagesFromChannel(data.channel_id, [data.id], data.guild_id);
  }

  private handleMessageDeleteBulk(data: GatewayMessageDeleteBulkData): void {
    if (!Array.isArray(data.ids) || typeof data.channel_id !== "string") {
      return;
    }
    this.deleteMessagesFromChannel(data.channel_id, data.ids, data.guild_id);
  }

  private deleteMessagesFromChannel(
    channelId: Snowflake,
    messageIds: readonly Snowflake[],
    guildIdHint?: Snowflake,
  ): void {
    const nowIso = this.nowIso();
    const buffer = this.messagesByChannel.get(channelId);
    const watermark = this.watermarks.get(channelId);
    const channel = this.getChannel(channelId);
    const fallbackGuildId = guildIdHint ?? channel?.guildId ?? null;
    const deletedSet = new Set(messageIds);

    for (const messageId of messageIds) {
      let deletedMsg: CachedMessage | undefined;
      if (buffer !== undefined) {
        const idx = buffer.findIndex((msg) => msg.id === messageId);
        if (idx !== -1) {
          deletedMsg = buffer.splice(idx, 1)[0];
        }
      }

      if (watermark !== undefined && deletedMsg !== undefined) {
        const isSelfAuthor =
          this.botUser !== null && deletedMsg.author.id === this.botUser.id;
        const wasUnread =
          watermark.lastReadMessageId === null ||
          compareSnowflakes(deletedMsg.id, watermark.lastReadMessageId) > 0;
        if (!isSelfAuthor && wasUnread) {
          watermark.unreadCount = Math.max(0, watermark.unreadCount - 1);
          if (deletedMsg.mentionsBot) {
            watermark.mentionCount = Math.max(0, watermark.mentionCount - 1);
          }
        }
      }

      const event: WatchMessageDeleteEvent = {
        type: WatchEventTypeValue.MESSAGE_DELETE,
        timestamp: nowIso,
        channelId,
        guildId: deletedMsg?.guildId ?? fallbackGuildId,
        messageId,
      };
      this.publishWatchEvent(channelId, event);
    }

    if (buffer !== undefined && buffer.length === 0) {
      this.messagesByChannel.delete(channelId);
    }

    const currentMeta = this.latestMessageMetaByChannel.get(channelId);
    if (
      (currentMeta !== undefined && deletedSet.has(currentMeta.id)) ||
      (watermark !== undefined &&
        watermark.lastMessageId !== null &&
        deletedSet.has(watermark.lastMessageId)) ||
      (channel !== null &&
        channel.lastMessageId !== null &&
        deletedSet.has(channel.lastMessageId))
    ) {
      const newestRemaining =
        buffer !== undefined && buffer.length > 0
          ? buffer[buffer.length - 1]!
          : undefined;
      if (newestRemaining !== undefined) {
        this.latestMessageMetaByChannel.set(channelId, newestRemaining);
        if (watermark !== undefined) {
          watermark.lastMessageId = newestRemaining.id;
          watermark.updatedAt = nowIso;
        }
        if (channel !== null) {
          channel.lastMessageId = newestRemaining.id;
          channel.updatedAt = nowIso;
        }
      } else {
        this.latestMessageMetaByChannel.delete(channelId);
        if (watermark !== undefined) {
          watermark.lastMessageId = watermark.lastReadMessageId;
          watermark.updatedAt = nowIso;
        }
        if (
          channel !== null &&
          channel.lastMessageId !== null &&
          deletedSet.has(channel.lastMessageId)
        ) {
          channel.lastMessageId = watermark?.lastReadMessageId ?? null;
          channel.updatedAt = nowIso;
        }
      }
    }
  }

  private handleReactionAdd(data: GatewayReactionAddData): void {
    if (
      typeof data.channel_id !== "string" ||
      typeof data.message_id !== "string" ||
      typeof data.user_id !== "string" ||
      !isPlainRecord(data.emoji)
    ) {
      return;
    }

    if (data.member?.user !== undefined) {
      this.upsertUser(data.member.user);
    }
    const reactionGuildId =
      data.guild_id ?? this.getChannel(data.channel_id)?.guildId ?? null;
    if (reactionGuildId !== null && isPlainRecord(data.member)) {
      this.upsertGuildMemberFromPartial(
        reactionGuildId,
        data.member.user?.id ?? data.user_id,
        data.member as unknown as Record<string, unknown>,
      );
    }

    const emojiInfo = extractEmojiInfo(data.emoji);
    const cached = this.findCachedMessage(data.channel_id, data.message_id);
    const isSelf = this.botUser !== null && data.user_id === this.botUser.id;

    if (cached !== undefined) {
      const existing = cached.reactions.find((reaction) =>
        reactionsMatchEmoji(reaction, emojiInfo),
      );
      if (existing !== undefined) {
        existing.count += 1;
        if (isSelf) {
          existing.me = true;
        }
      } else {
        cached.reactions.push({
          emojiKey: emojiInfo.emojiKey,
          emojiName: emojiInfo.emojiName,
          emojiId: emojiInfo.emojiId,
          animated: emojiInfo.animated,
          count: 1,
          me: isSelf,
        });
      }
    }

    const event: WatchReactionAddEvent = {
      type: WatchEventTypeValue.REACTION_ADD,
      timestamp: this.nowIso(),
      channelId: data.channel_id,
      guildId:
        data.guild_id ?? this.getChannel(data.channel_id)?.guildId ?? null,
      messageId: data.message_id,
      userId: data.user_id,
      emojiKey: emojiInfo.emojiKey,
      emojiName: emojiInfo.emojiName,
      emojiId: emojiInfo.emojiId,
      animated: emojiInfo.animated,
    };
    this.publishWatchEvent(data.channel_id, event);
  }

  private handleReactionRemove(data: GatewayReactionRemoveData): void {
    if (
      typeof data.channel_id !== "string" ||
      typeof data.message_id !== "string" ||
      typeof data.user_id !== "string" ||
      !isPlainRecord(data.emoji)
    ) {
      return;
    }

    const emojiInfo = extractEmojiInfo(data.emoji);
    const cached = this.findCachedMessage(data.channel_id, data.message_id);
    const isSelf = this.botUser !== null && data.user_id === this.botUser.id;

    if (cached !== undefined) {
      const idx = cached.reactions.findIndex((reaction) =>
        reactionsMatchEmoji(reaction, emojiInfo),
      );
      if (idx !== -1) {
        const existing = cached.reactions[idx]!;
        existing.count = Math.max(0, existing.count - 1);
        if (isSelf) {
          existing.me = false;
        }
        if (existing.count === 0) {
          cached.reactions.splice(idx, 1);
        }
      }
    }

    const event: WatchReactionRemoveEvent = {
      type: WatchEventTypeValue.REACTION_REMOVE,
      timestamp: this.nowIso(),
      channelId: data.channel_id,
      guildId:
        data.guild_id ?? this.getChannel(data.channel_id)?.guildId ?? null,
      messageId: data.message_id,
      userId: data.user_id,
      emojiKey: emojiInfo.emojiKey,
      emojiName: emojiInfo.emojiName,
      emojiId: emojiInfo.emojiId,
      animated: emojiInfo.animated,
    };
    this.publishWatchEvent(data.channel_id, event);
  }

  private handleReactionRemoveAll(data: GatewayReactionRemoveAllData): void {
    if (
      typeof data.channel_id !== "string" ||
      typeof data.message_id !== "string"
    ) {
      return;
    }
    const cached = this.findCachedMessage(data.channel_id, data.message_id);
    if (cached !== undefined) {
      cached.reactions = [];
    }
  }

  private handleReactionRemoveEmoji(
    data: GatewayReactionRemoveEmojiData,
  ): void {
    if (
      typeof data.channel_id !== "string" ||
      typeof data.message_id !== "string" ||
      !isPlainRecord(data.emoji)
    ) {
      return;
    }
    const emojiInfo = extractEmojiInfo(data.emoji);
    const cached = this.findCachedMessage(data.channel_id, data.message_id);
    if (cached !== undefined) {
      cached.reactions = cached.reactions.filter(
        (reaction) => !reactionsMatchEmoji(reaction, emojiInfo),
      );
    }
  }

  private findCachedMessage(
    channelId: Snowflake,
    messageId: Snowflake,
  ): CachedMessage | undefined {
    const buffer = this.messagesByChannel.get(channelId);
    return buffer?.find((msg) => msg.id === messageId);
  }

  private insertMessageIntoBuffer(message: CachedMessage): boolean {
    let buffer = this.messagesByChannel.get(message.channelId);
    if (buffer === undefined) {
      buffer = [message];
      this.messagesByChannel.set(message.channelId, buffer);
      return false;
    }

    const existingIndex = buffer.findIndex((m) => m.id === message.id);
    if (existingIndex !== -1) {
      buffer[existingIndex] = message;
      return true;
    }

    if (
      buffer.length === 0 ||
      compareSnowflakes(buffer[buffer.length - 1]!.id, message.id) < 0
    ) {
      buffer.push(message);
    } else {
      let insertAt = 0;
      while (
        insertAt < buffer.length &&
        compareSnowflakes(buffer[insertAt]!.id, message.id) < 0
      ) {
        insertAt += 1;
      }
      buffer.splice(insertAt, 0, message);
    }

    if (buffer.length > this.maxMessagesPerChannel) {
      buffer.splice(0, buffer.length - this.maxMessagesPerChannel);
    }
    return false;
  }

  private computeMentionsBot(params: {
    guildId: Snowflake | null;
    isDm: boolean;
    mentionEveryone: boolean;
    mentionUserIds: readonly Snowflake[];
    mentionRoleIds: readonly Snowflake[];
  }): boolean {
    if (params.isDm || params.mentionEveryone) {
      return true;
    }
    if (this.botUser !== null && params.mentionUserIds.includes(this.botUser.id)) {
      return true;
    }
    if (params.guildId !== null && params.mentionRoleIds.length > 0) {
      const guild = this.guilds.get(params.guildId);
      if (guild !== undefined && guild.botRoleIds.length > 0) {
        for (const roleId of params.mentionRoleIds) {
          if (guild.botRoleIds.includes(roleId)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  private resolveLatestMessageForChannel(
    channelId: Snowflake,
  ): CachedMessage | undefined {
    const meta = this.latestMessageMetaByChannel.get(channelId);
    if (meta !== undefined) {
      return meta;
    }
    const buffer = this.messagesByChannel.get(channelId);
    if (buffer !== undefined && buffer.length > 0) {
      return buffer[buffer.length - 1];
    }
    return undefined;
  }

  private publishWatchEvent(channelId: Snowflake, event: WatchEvent): void {
    const subs = this.subscribersByChannel.get(channelId);
    if (subs === undefined || subs.size === 0) {
      return;
    }
    for (const sub of Array.from(subs)) {
      this.deliverToSubscription(sub, event);
    }
  }

  private deliverToSubscription(
    subscription: WatchSubscription,
    event: WatchEvent,
  ): void {
    if (
      subscription.filter !== null &&
      !subscription.filter.has(event.type)
    ) {
      return;
    }
    try {
      subscription.listener(event);
    } catch {
      // Isolate broken watch listeners from disrupting cache state or other watchers.
    }
  }
}
