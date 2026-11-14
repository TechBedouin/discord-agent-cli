import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  StateCache,
  compareSnowflakes,
} from "../dist/daemon/state-cache.js";
import {
  DiscordChannelType,
  DiscordRelationshipType,
  type DiscordChannel,
  type DiscordGuild,
  type DiscordInvite,
  type DiscordMessage,
  type DiscordPartialGuild,
  type DiscordUser,
  type GatewayReadyData,
  type WatchEvent,
} from "../dist/shared/types.js";

const BOT_USER: DiscordUser = {
  id: "100000000000000001",
  username: "CliBot",
  discriminator: "0",
  global_name: "CLI Bot",
  bot: true,
};

const ALICE: DiscordUser = {
  id: "200000000000000001",
  username: "alice",
  discriminator: "0",
  global_name: "Alice",
};

const BOB: DiscordUser = {
  id: "200000000000000002",
  username: "bob",
  discriminator: "0",
};

function makeClock(startIso = "2026-11-13T18:00:00.000Z") {
  let ms = Date.parse(startIso);
  return {
    now: () => {
      const d = new Date(ms);
      ms += 1000;
      return d;
    },
  };
}

function makeMessage(overrides: Partial<DiscordMessage> & { id: string; channel_id: string }): DiscordMessage {
  return {
    author: ALICE,
    content: "hello",
    timestamp: "2026-11-13T18:00:00.000Z",
    type: 0,
    ...overrides,
  };
}

function hydrateBasicSession(cache: StateCache): void {
  cache.handleGatewayDispatch("READY", {
    v: 10,
    user: BOT_USER,
    guilds: [{ id: "10", unavailable: true }],
    session_id: "sess-1",
    resume_gateway_url: "wss://resume.example",
    application: { id: BOT_USER.id, flags: 0 },
  });

  const guild: DiscordGuild = {
    id: "10",
    name: "Test Guild",
    owner_id: ALICE.id,
    member_count: 12,
    channels: [
      {
        id: "100",
        type: DiscordChannelType.GUILD_TEXT,
        name: "general",
        topic: "Main chat",
      },
      {
        id: "101",
        type: DiscordChannelType.GUILD_TEXT,
        guild_id: "10",
        name: "alerts",
      },
    ],
    threads: [
      {
        id: "102",
        type: DiscordChannelType.PUBLIC_THREAD,
        name: "thread-1",
        parent_id: "100",
      },
    ],
    members: [
      {
        user: BOT_USER,
        roles: ["500", "501"],
        joined_at: "2026-01-01T00:00:00.000Z",
      },
      {
        user: ALICE,
        roles: ["502"],
        joined_at: "2026-01-01T00:00:00.000Z",
      },
    ],
  };

  cache.handleGatewayDispatch("GUILD_CREATE", guild);
}

describe("daemon/state-cache StateCache", () => {
  it("handles READY, GUILD_CREATE (botRoleIds extraction), GUILD_MEMBER_UPDATE, GUILD_UPDATE, and GUILD_DELETE", () => {
    const cache = new StateCache({ now: makeClock().now });

    cache.handleGatewayDispatch("READY", {
      v: 10,
      user: BOT_USER,
      guilds: [{ id: "10", unavailable: true }],
      session_id: "sess-1",
      resume_gateway_url: "wss://resume.example",
      application: { id: BOT_USER.id, flags: 0 },
    });

    assert.equal(cache.getBotUser()?.id, BOT_USER.id);
    assert.equal(cache.guilds.get("10")?.unavailable, true);

    hydrateBasicSession(cache);

    const guild = cache.guilds.get("10");
    assert.ok(guild);
    assert.equal(guild.name, "Test Guild");
    assert.equal(guild.unavailable, false);
    assert.deepEqual(guild.botRoleIds, ["500", "501"]);
    assert.deepEqual(guild.channelIds, ["100", "101", "102"]);
    assert.equal(cache.channels.get("100")?.guildId, "10");
    assert.equal(cache.channels.get("102")?.parentId, "100");

    // GUILD_MEMBER_UPDATE for bot updates botRoleIds; for another user does not.
    cache.handleGatewayDispatch("GUILD_MEMBER_UPDATE", {
      guild_id: "10",
      user: BOT_USER,
      roles: ["500", "599"],
      joined_at: "2026-01-01T00:00:00.000Z",
    });
    assert.deepEqual(cache.guilds.get("10")?.botRoleIds, ["500", "599"]);

    cache.handleGatewayDispatch("GUILD_MEMBER_UPDATE", {
      guild_id: "10",
      user: BOB,
      roles: ["999"],
      joined_at: "2026-01-01T00:00:00.000Z",
    });
    assert.deepEqual(cache.guilds.get("10")?.botRoleIds, ["500", "599"]);
    assert.equal(cache.users.get(BOB.id)?.username, "bob");

    // GUILD_UPDATE keeps existing channelIds while updating guild name.
    cache.handleGatewayDispatch("GUILD_UPDATE", {
      id: "10",
      name: "Renamed Guild",
      owner_id: ALICE.id,
    });
    assert.equal(cache.guilds.get("10")?.name, "Renamed Guild");
    assert.deepEqual(cache.guilds.get("10")?.channelIds, ["100", "101", "102"]);

    // Temporary outage (unavailable: true) preserves guild channels.
    cache.handleGatewayDispatch("GUILD_DELETE", { id: "10", unavailable: true });
    assert.equal(cache.guilds.get("10")?.unavailable, true);
    assert.ok(cache.channels.has("100"));

    // Subsequent READY clears restHydratedChannels.
    cache.restHydratedChannels.add("100");
    cache.handleGatewayDispatch("READY", {
      v: 10,
      user: BOT_USER,
      guilds: [{ id: "10", unavailable: true }],
      session_id: "sess-2",
      resume_gateway_url: "wss://resume.example",
      application: { id: BOT_USER.id, flags: 0 },
    });
    assert.equal(cache.restHydratedChannels.size, 0);

    // Re-hydrate then permanent GUILD_DELETE removes guild + its channels.
    hydrateBasicSession(cache);
    cache.handleGatewayDispatch("GUILD_DELETE", { id: "10" });
    assert.equal(cache.guilds.has("10"), false);
    assert.equal(cache.channels.has("100"), false);
    assert.equal(cache.channels.has("102"), false);
  });

  it("handles CHANNEL_CREATE/UPDATE/DELETE across guild channels and DM channels", () => {
    const cache = new StateCache({ now: makeClock().now });
    hydrateBasicSession(cache);

    const newGuildChannel: DiscordChannel = {
      id: "103",
      type: DiscordChannelType.GUILD_TEXT,
      guild_id: "10",
      name: "dev",
    };
    cache.handleGatewayDispatch("CHANNEL_CREATE", newGuildChannel);
    assert.equal(cache.channels.get("103")?.isDm, false);
    assert.ok(cache.guilds.get("10")?.channelIds.includes("103"));

    const dmChannel: DiscordChannel = {
      id: "300",
      type: DiscordChannelType.DM,
      recipients: [ALICE],
    };
    cache.handleGatewayDispatch("CHANNEL_CREATE", dmChannel);
    assert.equal(cache.channels.has("300"), false);
    assert.equal(cache.dmChannels.get("300")?.isDm, true);
    assert.equal(cache.dmChannels.get("300")?.name, "Alice");
    assert.deepEqual(cache.dmChannels.get("300")?.recipientIds, [ALICE.id]);

    cache.handleGatewayDispatch("CHANNEL_UPDATE", {
      id: "103",
      type: DiscordChannelType.GUILD_TEXT,
      guild_id: "10",
      name: "dev-renamed",
      topic: "Updated topic",
    });
    assert.equal(cache.channels.get("103")?.name, "dev-renamed");
    assert.equal(cache.channels.get("103")?.topic, "Updated topic");

    cache.handleGatewayDispatch("CHANNEL_DELETE", {
      id: "103",
      guild_id: "10",
    });
    assert.equal(cache.channels.has("103"), false);
    assert.equal(cache.guilds.get("10")?.channelIds.includes("103"), false);
  });

  it("tracks unread and mention counts for bot mention, role mention, @everyone, and DMs while excluding bot's own messages", () => {
    const cache = new StateCache({ now: makeClock().now });
    hydrateBasicSession(cache);

    // 1. Plain guild message -> unread +1, mention +0.
    cache.handleGatewayDispatch(
      "MESSAGE_CREATE",
      makeMessage({ id: "1000", channel_id: "100", guild_id: "10", content: "hi" }),
    );
    // 2. Direct bot user mention -> unread +1, mention +1.
    cache.handleGatewayDispatch(
      "MESSAGE_CREATE",
      makeMessage({
        id: "1001",
        channel_id: "100",
        guild_id: "10",
        content: "ping bot",
        mentions: [BOT_USER],
      }),
    );
    // 3. Role mention matching botRoleIds ("501") -> unread +1, mention +1.
    cache.handleGatewayDispatch(
      "MESSAGE_CREATE",
      makeMessage({
        id: "1002",
        channel_id: "100",
        guild_id: "10",
        content: "role ping",
        mention_roles: ["501"],
      }),
    );
    // 4. Unrelated role mention ("999") -> unread +1, mention +0.
    cache.handleGatewayDispatch(
      "MESSAGE_CREATE",
      makeMessage({
        id: "1003",
        channel_id: "100",
        guild_id: "10",
        content: "other role",
        mention_roles: ["999"],
      }),
    );
    // 5. @everyone -> unread +1, mention +1.
    cache.handleGatewayDispatch(
      "MESSAGE_CREATE",
      makeMessage({
        id: "1004",
        channel_id: "101",
        guild_id: "10",
        content: "all hands",
        mention_everyone: true,
      }),
    );
    // 6. Bot's own message -> cached, advances lastMessageId, but excluded from unread/mention counts.
    cache.handleGatewayDispatch(
      "MESSAGE_CREATE",
      makeMessage({
        id: "1005",
        channel_id: "100",
        guild_id: "10",
        author: BOT_USER,
        content: "bot reply",
        mention_everyone: true,
      }),
    );
    // 7. DM message (no guild_id, auto-creates dmChannels stub) -> unread +1, mention +1.
    cache.handleGatewayDispatch(
      "MESSAGE_CREATE",
      makeMessage({
        id: "1006",
        channel_id: "900",
        author: BOB,
        content: "hey in dm",
      }),
    );
    // 8. Bot's own message in DM -> excluded from unread/mention counts.
    cache.handleGatewayDispatch(
      "MESSAGE_CREATE",
      makeMessage({
        id: "1007",
        channel_id: "900",
        author: BOT_USER,
        content: "bot dm ack",
      }),
    );
    // 9. Duplicate MESSAGE_CREATE for "1001" -> must not double-count.
    cache.handleGatewayDispatch(
      "MESSAGE_CREATE",
      makeMessage({
        id: "1001",
        channel_id: "100",
        guild_id: "10",
        content: "ping bot",
        mentions: [BOT_USER],
      }),
    );

    assert.equal(cache.dmChannels.get("900")?.isDm, true);
    assert.equal(cache.dmChannels.get("900")?.name, "bob");

    const wm100 = cache.getWatermark("100");
    assert.equal(wm100?.unreadCount, 4);
    assert.equal(wm100?.mentionCount, 2);
    assert.equal(wm100?.lastMessageId, "1005");

    const wm101 = cache.getWatermark("101");
    assert.equal(wm101?.unreadCount, 1);
    assert.equal(wm101?.mentionCount, 1);

    const wm900 = cache.getWatermark("900");
    assert.equal(wm900?.unreadCount, 1);
    assert.equal(wm900?.mentionCount, 1);

    const allUnread = cache.getUnread();
    assert.equal(allUnread.totalUnreadChannels, 3);
    assert.equal(allUnread.totalUnreadMessages, 6);
    assert.equal(allUnread.totalMentions, 4);
    assert.deepEqual(
      allUnread.items.map((item) => item.channelId),
      ["900", "100", "101"],
    );

    const guildOnlyUnread = cache.getUnread({ includeDms: false });
    assert.equal(guildOnlyUnread.totalUnreadChannels, 2);
    assert.equal(guildOnlyUnread.items.some((i) => i.isDm), false);

    // Channel with only non-mention unread message should be filtered by mentionsOnly.
    cache.handleGatewayDispatch(
      "MESSAGE_CREATE",
      makeMessage({
        id: "1008",
        channel_id: "102",
        guild_id: "10",
        content: "no mention here",
      }),
    );
    const mentionsOnly = cache.getUnread({ mentionsOnly: true });
    assert.equal(mentionsOnly.totalUnreadChannels, 3);
    assert.equal(mentionsOnly.items.some((i) => i.channelId === "102"), false);
  });

  it("applies partial MESSAGE_UPDATE cleanly and adjusts unread mention counts", () => {
    const cache = new StateCache({ now: makeClock().now });
    hydrateBasicSession(cache);

    cache.handleGatewayDispatch(
      "MESSAGE_CREATE",
      makeMessage({
        id: "2000",
        channel_id: "100",
        guild_id: "10",
        content: "initial content",
        attachments: [
          {
            id: "a1",
            filename: "spec.txt",
            size: 42,
            url: "https://cdn.example/spec.txt",
          },
        ],
      }),
    );
    assert.equal(cache.getWatermark("100")?.mentionCount, 0);

    // Partial update without author/timestamp/attachments adds a bot mention.
    cache.handleGatewayDispatch("MESSAGE_UPDATE", {
      id: "2000",
      channel_id: "100",
      content: "edited with mention",
      edited_timestamp: "2026-11-13T18:05:00.000Z",
      mentions: [BOT_USER],
    });

    const [updated] = cache.getCachedMessages("100");
    assert.ok(updated);
    assert.equal(updated.content, "edited with mention");
    assert.equal(updated.editedTimestamp, "2026-11-13T18:05:00.000Z");
    assert.equal(updated.author.id, ALICE.id);
    assert.equal(updated.attachments.length, 1);
    assert.equal(updated.mentionsBot, true);
    assert.equal(cache.getWatermark("100")?.mentionCount, 1);

    // Partial update removing mention decrements mentionCount back to 0.
    cache.handleGatewayDispatch("MESSAGE_UPDATE", {
      id: "2000",
      channel_id: "100",
      mentions: [],
    });
    assert.equal(cache.getCachedMessages("100")[0]?.mentionsBot, false);
    assert.equal(cache.getWatermark("100")?.mentionCount, 0);
  });

  it("handles MESSAGE_DELETE, MESSAGE_DELETE_BULK, and MESSAGE_REACTION_* events", () => {
    const cache = new StateCache({ now: makeClock().now });
    hydrateBasicSession(cache);

    cache.handleGatewayDispatch(
      "MESSAGE_CREATE",
      makeMessage({
        id: "3001",
        channel_id: "100",
        guild_id: "10",
        content: "m1",
        mentions: [BOT_USER],
      }),
    );
    cache.handleGatewayDispatch(
      "MESSAGE_CREATE",
      makeMessage({
        id: "3002",
        channel_id: "100",
        guild_id: "10",
        content: "m2",
      }),
    );
    cache.handleGatewayDispatch(
      "MESSAGE_CREATE",
      makeMessage({
        id: "3003",
        channel_id: "100",
        guild_id: "10",
        content: "m3",
        mentions: [BOT_USER],
      }),
    );

    // Reactions: add Unicode, add custom animated, bot reacts & removes.
    cache.handleGatewayDispatch("MESSAGE_REACTION_ADD", {
      user_id: ALICE.id,
      channel_id: "100",
      message_id: "3001",
      guild_id: "10",
      emoji: { id: null, name: "🔥" },
    });
    cache.handleGatewayDispatch("MESSAGE_REACTION_ADD", {
      user_id: BOT_USER.id,
      channel_id: "100",
      message_id: "3001",
      guild_id: "10",
      emoji: { id: null, name: "🔥" },
    });
    cache.handleGatewayDispatch("MESSAGE_REACTION_ADD", {
      user_id: BOB.id,
      channel_id: "100",
      message_id: "3001",
      guild_id: "10",
      emoji: { id: "777", name: "spin", animated: true },
    });

    let msg3001 = cache.getCachedMessages("100")[0]!;
    assert.equal(msg3001.reactions.length, 2);
    assert.deepEqual(msg3001.reactions[0], {
      emojiKey: "🔥",
      emojiName: "🔥",
      emojiId: null,
      animated: false,
      count: 2,
      me: true,
    });
    assert.deepEqual(msg3001.reactions[1], {
      emojiKey: "spin:777",
      emojiName: "spin",
      emojiId: "777",
      animated: true,
      count: 1,
      me: false,
    });

    cache.handleGatewayDispatch("MESSAGE_REACTION_REMOVE", {
      user_id: BOT_USER.id,
      channel_id: "100",
      message_id: "3001",
      guild_id: "10",
      emoji: { id: null, name: "🔥" },
    });
    msg3001 = cache.getCachedMessages("100")[0]!;
    assert.equal(msg3001.reactions[0]!.count, 1);
    assert.equal(msg3001.reactions[0]!.me, false);

    cache.handleGatewayDispatch("MESSAGE_REACTION_REMOVE_EMOJI", {
      channel_id: "100",
      message_id: "3001",
      guild_id: "10",
      emoji: { id: "777", name: "spin" },
    });
    assert.equal(cache.getCachedMessages("100")[0]!.reactions.length, 1);

    cache.handleGatewayDispatch("MESSAGE_REACTION_REMOVE_ALL", {
      channel_id: "100",
      message_id: "3001",
      guild_id: "10",
    });
    assert.equal(cache.getCachedMessages("100")[0]!.reactions.length, 0);

    // Single delete + bulk delete update unread/mention counters and lastMessageId.
    cache.handleGatewayDispatch("MESSAGE_DELETE", {
      id: "3003",
      channel_id: "100",
      guild_id: "10",
    });
    assert.equal(cache.getWatermark("100")?.unreadCount, 2);
    assert.equal(cache.getWatermark("100")?.mentionCount, 1);
    assert.equal(cache.getWatermark("100")?.lastMessageId, "3002");

    cache.handleGatewayDispatch("MESSAGE_DELETE_BULK", {
      ids: ["3001", "3002"],
      channel_id: "100",
      guild_id: "10",
    });
    assert.equal(cache.messagesByChannel.has("100"), false);
    assert.equal(cache.getWatermark("100")?.unreadCount, 0);
    assert.equal(cache.getWatermark("100")?.mentionCount, 0);
    assert.equal(cache.getWatermark("100")?.lastMessageId, null);
  });

  it("maintains BigInt snowflake ordering, bounded buffer eviction, and cursor filtering", () => {
    assert.equal(compareSnowflakes("99", "100"), -1);
    assert.equal(
      compareSnowflakes("9007199254740992", "9007199254740993"),
      -1,
    );
    assert.equal(
      compareSnowflakes("18446744073709551615", "9007199254740993"),
      1,
    );
    assert.equal(compareSnowflakes("42", "42"), 0);

    const cache = new StateCache({
      maxMessagesPerChannel: 3,
      now: makeClock().now,
    });
    hydrateBasicSession(cache);

    // Insert out of order including >53-bit snowflakes; buffer capacity is 3.
    const ids = [
      "9007199254740995",
      "9007199254740992",
      "99",
      "9007199254740993",
      "9007199254740994",
    ];
    for (const id of ids) {
      cache.handleGatewayDispatch(
        "MESSAGE_CREATE",
        makeMessage({ id, channel_id: "100", guild_id: "10", content: `msg-${id}` }),
      );
    }

    const retained = cache.getCachedMessages("100");
    assert.deepEqual(
      retained.map((m) => m.id),
      ["9007199254740993", "9007199254740994", "9007199254740995"],
    );

    assert.deepEqual(
      cache
        .getCachedMessages("100", { before: "9007199254740995", limit: 1 })
        .map((m) => m.id),
      ["9007199254740994"],
    );
    assert.deepEqual(
      cache
        .getCachedMessages("100", { after: "9007199254740993", limit: 1 })
        .map((m) => m.id),
      ["9007199254740994"],
    );
  });

  it("tracks restHydratedChannels, canServeLatestFromCache, mergeRestMessages, and markChannelRead", () => {
    const cache = new StateCache({
      maxMessagesPerChannel: 5,
      now: makeClock().now,
    });
    hydrateBasicSession(cache);

    // Gateway-only messages do NOT mark channel as REST-hydrated.
    cache.handleGatewayDispatch(
      "MESSAGE_CREATE",
      makeMessage({ id: "5003", channel_id: "100", guild_id: "10", content: "live" }),
    );
    assert.equal(cache.canServeLatestFromCache("100", 1), false);

    // Historical REST page (isLatestTail = false) does not hydrate latest tail.
    const historical = cache.mergeRestMessages(
      "100",
      [makeMessage({ id: "4000", channel_id: "100", guild_id: "10", content: "old" })],
      false,
    );
    assert.equal(historical.length, 1);
    assert.equal(cache.canServeLatestFromCache("100", 1), false);

    // Latest REST tail hydration marks channel hydrated & merges deduped sorted messages.
    cache.mergeRestTailMessages("100", [
      makeMessage({
        id: "5002",
        channel_id: "100",
        guild_id: "10",
        content: "rest-2",
        mentions: [BOT_USER],
      }),
      makeMessage({ id: "5001", channel_id: "100", guild_id: "10", content: "rest-1" }),
    ]);

    assert.equal(cache.restHydratedChannels.has("100"), true);
    assert.equal(cache.canServeLatestFromCache("100", 3), true);
    assert.equal(cache.canServeLatestFromCache("100", 4), false);
    assert.equal(cache.canServeLatestFromCache("100", 0), false);
    assert.deepEqual(
      cache.getCachedMessages("100").map((m) => m.id),
      ["5001", "5002", "5003"],
    );

    // Partial markChannelRead up to "5001" leaves 5002 (mention) and 5003 unread.
    const markedPartial = cache.markChannelRead("100", "5001");
    assert.equal(markedPartial, "5001");
    assert.equal(cache.getWatermark("100")?.unreadCount, 2);
    assert.equal(cache.getWatermark("100")?.mentionCount, 1);

    // Never regresses backwards when passed an older snowflake.
    const noRegress = cache.markChannelRead("100", "5000");
    assert.equal(noRegress, "5001");

    // Full markChannelRead advances to newest message and clears unread/mention counts.
    const markedAll = cache.markChannelRead("100");
    assert.equal(markedAll, "5003");
    assert.equal(cache.getWatermark("100")?.unreadCount, 0);
    assert.equal(cache.getWatermark("100")?.mentionCount, 0);
  });

  it("delivers and filters subscribeWatch events cleanly with isolated listeners", () => {
    const cache = new StateCache({ now: makeClock().now });
    hydrateBasicSession(cache);

    const allEvents: WatchEvent[] = [];
    const filteredEvents: WatchEvent[] = [];
    const otherChannelEvents: WatchEvent[] = [];

    const unsubBroken = cache.subscribeWatch("100", () => {
      throw new Error("listener exploded");
    });
    const unsubAll = cache.subscribeWatch(
      "100",
      (ev) => allEvents.push(ev),
      null,
      { gatewayState: "ready" },
    );
    const unsubFiltered = cache.subscribeWatch(
      "100",
      (ev) => filteredEvents.push(ev),
      ["message_create", "reaction_add"],
      { emitReady: true, gatewayState: "ready" },
    );
    const unsubOther = cache.subscribeWatch(
      "101",
      (ev) => otherChannelEvents.push(ev),
      null,
      { emitReady: false },
    );

    assert.equal(cache.getCacheSnapshot().activeWatchers, 4);

    // Channel 100 unfiltered got initial ready; filtered watcher filtered out ready.
    assert.deepEqual(
      allEvents.map((e) => e.type),
      ["ready"],
    );
    assert.equal(filteredEvents.length, 0);

    cache.handleGatewayDispatch(
      "MESSAGE_CREATE",
      makeMessage({ id: "6001", channel_id: "100", guild_id: "10", content: "one" }),
    );
    cache.handleGatewayDispatch("MESSAGE_UPDATE", {
      id: "6001",
      channel_id: "100",
      content: "one-edited",
    });
    cache.handleGatewayDispatch("MESSAGE_REACTION_ADD", {
      user_id: ALICE.id,
      channel_id: "100",
      message_id: "6001",
      guild_id: "10",
      emoji: { id: null, name: "👍" },
    });
    cache.handleGatewayDispatch("MESSAGE_REACTION_REMOVE", {
      user_id: ALICE.id,
      channel_id: "100",
      message_id: "6001",
      guild_id: "10",
      emoji: { id: null, name: "👍" },
    });
    cache.handleGatewayDispatch("MESSAGE_DELETE", {
      id: "6001",
      channel_id: "100",
      guild_id: "10",
    });
    cache.emitGatewayState("reconnecting", "heartbeat missed");

    assert.deepEqual(
      allEvents.map((e) => e.type),
      [
        "ready",
        "message_create",
        "message_update",
        "reaction_add",
        "reaction_remove",
        "message_delete",
        "gateway_state",
      ],
    );
    assert.deepEqual(
      filteredEvents.map((e) => e.type),
      ["message_create", "reaction_add"],
    );
    assert.deepEqual(
      otherChannelEvents.map((e) => e.type),
      ["gateway_state"],
    );
    assert.equal(cache.getGatewayState(), "reconnecting");

    unsubAll();
    unsubAll(); // idempotent
    unsubFiltered();
    unsubOther();
    unsubBroken();

    assert.equal(cache.getCacheSnapshot().activeWatchers, 0);

    const countBefore = allEvents.length;
    cache.handleGatewayDispatch(
      "MESSAGE_CREATE",
      makeMessage({ id: "6002", channel_id: "100", guild_id: "10", content: "after" }),
    );
    assert.equal(allEvents.length, countBefore);
  });

  it("hydrates user-mode READY guilds, private_channels, relationships, users, and merged_members", () => {
    const cache = new StateCache({ now: makeClock().now });
    const SELF_USER: DiscordUser = {
      id: "900000000000000001",
      username: "self_user",
      discriminator: "0",
      global_name: "Self User",
      bot: false,
    };
    const CHARLIE: DiscordUser = {
      id: "200000000000000003",
      username: "charlie",
      discriminator: "0",
      global_name: "Charlie",
    };

    const userReadyPayload: GatewayReadyData = {
      v: 10,
      user: SELF_USER,
      session_id: "user-ready-sess",
      users: [CHARLIE],
      relationships: [
        {
          id: BOB.id,
          type: DiscordRelationshipType.FRIEND,
          nickname: "Bestie Bob",
          user: BOB,
        },
      ],
      user_settings: {
        locale: "en-US",
        theme: "dark",
        status: "online",
        custom_status: {
          text: "shipping",
          emoji_name: "🚀",
        },
      },
      private_channels: [
        {
          id: "7001",
          type: DiscordChannelType.DM,
          last_message_id: "80001",
          recipients: [ALICE],
        },
        {
          id: "7002",
          type: DiscordChannelType.GROUP_DM,
          name: "Core Team",
          last_message_id: "80005",
          recipients: [ALICE, BOB],
        },
      ],
      guilds: [
        {
          id: "10",
          properties: {
            id: "10",
            name: "User Hydrated Guild",
            icon: "guild-icon-hash",
            owner_id: ALICE.id,
          },
          member_count: 25,
          channels: [
            {
              id: "110",
              type: DiscordChannelType.GUILD_CATEGORY,
              name: "Text Channels",
              position: 0,
            },
            {
              id: "111",
              type: DiscordChannelType.GUILD_TEXT,
              name: "general",
              parent_id: "110",
              position: 1,
              topic: "Welcome",
              nsfw: false,
            },
          ],
          threads: [
            {
              id: "112",
              type: DiscordChannelType.PUBLIC_THREAD,
              name: "launch-thread",
              parent_id: "111",
              position: 0,
            },
          ],
          members: [
            {
              user: ALICE,
              nick: "AliceAdmin",
              roles: ["role-admin"],
              joined_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        {
          id: "20",
          unavailable: true,
        },
      ],
      merged_members: [
        [
          {
            user: SELF_USER,
            nick: "SelfNick",
            roles: ["role-self-1"],
            joined_at: "2026-02-01T00:00:00.000Z",
          },
        ],
        [
          {
            roles: ["role-unavail-self"],
            joined_at: "2026-03-01T00:00:00.000Z",
          },
        ],
      ],
    };

    cache.handleGatewayDispatch("READY", userReadyPayload);

    assert.equal(cache.getBotUser()?.id, SELF_USER.id);
    assert.equal(cache.users.get(CHARLIE.id)?.username, "charlie");
    assert.equal(cache.users.get(BOB.id)?.username, "bob");

    // Hydrated guild 10
    const guild10 = cache.guilds.get("10");
    assert.ok(guild10);
    assert.equal(guild10.name, "User Hydrated Guild");
    assert.equal(guild10.icon, "guild-icon-hash");
    assert.equal(guild10.ownerId, ALICE.id);
    assert.equal(guild10.unavailable, false);
    assert.equal(guild10.memberCount, 25);
    assert.deepEqual(guild10.botRoleIds, ["role-self-1"]);
    assert.deepEqual(guild10.channelIds, ["110", "111", "112"]);
    assert.equal(cache.hasHydratedGuildChannels("10"), true);
    assert.equal(cache.channels.get("110")?.guildId, "10");
    assert.equal(cache.channels.get("111")?.guildId, "10");
    assert.equal(cache.channels.get("112")?.guildId, "10");

    // Unavailable stub guild 20 preserves unavailable status while capturing merged_members self roles
    const guild20 = cache.guilds.get("20");
    assert.ok(guild20);
    assert.equal(guild20.unavailable, true);
    assert.equal(guild20.name, "");
    assert.deepEqual(guild20.channelIds, []);
    assert.deepEqual(guild20.botRoleIds, ["role-unavail-self"]);
    assert.equal(cache.hasHydratedGuildChannels("20"), false);

    // Hydrated guild members from guild.members + merged_members
    assert.deepEqual(cache.getGuildMember("10", ALICE.id)?.nickname, "AliceAdmin");
    assert.deepEqual(cache.getGuildMember("10", ALICE.id)?.roleIds, ["role-admin"]);
    assert.deepEqual(cache.getGuildMember("10", SELF_USER.id)?.nickname, "SelfNick");
    assert.deepEqual(cache.getGuildMember("10", SELF_USER.id)?.roleIds, ["role-self-1"]);

    // Private channels hydrated into dmChannels (not guild channels)
    assert.equal(cache.channels.has("7001"), false);
    assert.equal(cache.channels.has("7002"), false);
    assert.equal(cache.dmChannels.get("7001")?.isDm, true);
    assert.equal(cache.dmChannels.get("7001")?.name, "Alice");
    assert.equal(cache.dmChannels.get("7002")?.name, "Core Team");

    // Relationships & user_settings hydrated from READY with defensive copies
    const rels = cache.getRelationships();
    assert.equal(rels.length, 1);
    assert.equal(rels[0]!.id, BOB.id);
    assert.equal(rels[0]!.type, DiscordRelationshipType.FRIEND);
    assert.equal(rels[0]!.nickname, "Bestie Bob");
    assert.equal(rels[0]!.user?.username, "bob");
    rels[0]!.nickname = "mutated";
    assert.equal(cache.getRelationships()[0]!.nickname, "Bestie Bob");

    const settings = cache.getUserSettings();
    assert.ok(settings);
    assert.equal(settings.locale, "en-US");
    assert.equal(settings.status, "online");
    assert.deepEqual(settings.custom_status, {
      text: "shipping",
      emoji_name: "🚀",
    });
    settings.status = "mutated";
    assert.equal(cache.getUserSettings()?.status, "online");

    // USER_SETTINGS_UPDATE merges with existing settings & RELATIONSHIP_ADD/REMOVE mutate relationships
    cache.handleGatewayDispatch("USER_SETTINGS_UPDATE", {
      status: "dnd",
    });
    const mergedSettings = cache.getUserSettings();
    assert.equal(mergedSettings?.status, "dnd");
    assert.equal(mergedSettings?.locale, "en-US");
    assert.deepEqual(mergedSettings?.custom_status, {
      text: "shipping",
      emoji_name: "🚀",
    });

    cache.handleGatewayDispatch("RELATIONSHIP_ADD", {
      id: CHARLIE.id,
      type: DiscordRelationshipType.PENDING_INCOMING,
      user: CHARLIE,
    });
    assert.equal(cache.getRelationships().length, 2);
    cache.handleGatewayDispatch("RELATIONSHIP_REMOVE", {
      id: BOB.id,
    });
    assert.deepEqual(
      cache.getRelationships().map((r) => r.id),
      [CHARLIE.id],
    );

    // Subsequent READY resets relationships and userSettings
    cache.handleGatewayDispatch("READY", {
      v: 10,
      user: SELF_USER,
      guilds: [],
      session_id: "user-ready-reset",
    });
    assert.deepEqual(cache.getRelationships(), []);
    assert.equal(cache.getUserSettings(), null);
  });

  it("supports findDmChannelByUserId, upsertInviteResult, listGuilds, listGuildChannels, extractChannelMembers, and listDmChannels", () => {
    const cache = new StateCache({ now: makeClock().now });
    hydrateBasicSession(cache);

    // 1. DM helpers: findDmChannelByUserId ignores GROUP_DM and matches DM; listDmChannels sorts by lastMessageId desc.
    cache.upsertDmChannels([
      {
        id: "dm-group",
        type: DiscordChannelType.GROUP_DM,
        name: "Group With Bob",
        last_message_id: "9000",
        recipients: [ALICE, BOB],
      },
      {
        id: "dm-bob",
        type: DiscordChannelType.DM,
        last_message_id: "9500",
        recipients: [BOB],
      },
      {
        id: "dm-alice-empty",
        type: DiscordChannelType.DM,
        recipients: [ALICE],
      },
    ]);

    assert.equal(cache.findDmChannelByUserId(BOB.id)?.id, "dm-bob");
    assert.equal(cache.findDmChannelByUserId(ALICE.id)?.id, "dm-alice-empty");
    assert.equal(cache.findDmChannelByUserId("999999999999999999"), null);

    const dms = cache.listDmChannels();
    assert.deepEqual(
      dms.map((d) => d.channelId),
      ["dm-bob", "dm-group", "dm-alice-empty"],
    );
    assert.equal(dms[0]!.recipientId, BOB.id);
    assert.equal(dms[0]!.username, "bob");
    assert.equal(dms[1]!.name, "Group With Bob");
    assert.deepEqual(dms[1]!.recipientIds, [ALICE.id, BOB.id]);

    // 2. upsertInviteResult caches joined guild, presence count, inviter, and channel.
    const invite: DiscordInvite = {
      code: "join-xyz",
      guild: {
        id: "55",
        name: "Invite Guild",
        icon: "inv-icon",
      },
      channel: {
        id: "550",
        name: "welcome-room",
        type: DiscordChannelType.GUILD_TEXT,
      },
      inviter: {
        id: "300000000000000001",
        username: "inviter_user",
        discriminator: "0",
      },
      approximate_member_count: 88,
      approximate_presence_count: 19,
    };
    const joinResult = cache.upsertInviteResult(invite);
    assert.equal(joinResult.inviteCode, "join-xyz");
    assert.equal(joinResult.guild?.id, "55");
    assert.equal(joinResult.guild?.name, "Invite Guild");
    assert.equal(joinResult.guild?.memberCount, 88);
    assert.equal(joinResult.guild?.approximatePresenceCount, 19);
    assert.deepEqual(joinResult.channel, {
      id: "550",
      name: "welcome-room",
      type: DiscordChannelType.GUILD_TEXT,
    });
    assert.equal(cache.guilds.get("55")?.name, "Invite Guild");
    assert.equal(cache.channels.get("550")?.guildId, "55");
    assert.equal(cache.users.get("300000000000000001")?.username, "inviter_user");

    // 3. listGuilds & upsertPartialGuilds
    const partials: DiscordPartialGuild[] = [
      {
        id: "10",
        name: "Test Guild Updated",
        owner: true,
        approximate_member_count: 40,
        approximate_presence_count: 12,
      },
    ];
    cache.upsertPartialGuilds(partials);
    const listedGuilds = cache.listGuilds();
    const g10Summary = listedGuilds.find((g) => g.id === "10");
    assert.ok(g10Summary);
    assert.equal(g10Summary.name, "Test Guild Updated");
    assert.equal(g10Summary.owner, true);
    assert.equal(g10Summary.memberCount, 40);
    assert.equal(g10Summary.approximatePresenceCount, 12);
    // Preserves existing channelIds from hydrateBasicSession
    assert.deepEqual(cache.guilds.get("10")?.channelIds, ["100", "101", "102"]);

    // 4. listGuildChannels (non-overlapping categories / channels / threads) & upsertGuildChannels
    assert.equal(cache.listGuildChannels("unknown-guild"), null);

    cache.upsertGuildChannels(
      "55",
      [
        {
          id: "552",
          type: DiscordChannelType.GUILD_TEXT,
          name: "chat",
          parent_id: "551",
          position: 2,
          nsfw: false,
        },
        {
          id: "551",
          type: DiscordChannelType.GUILD_CATEGORY,
          name: "Main Category",
          position: 1,
        },
        {
          id: "550",
          type: DiscordChannelType.GUILD_TEXT,
          name: "welcome-room",
          position: 0,
        },
      ],
      [
        {
          id: "553",
          type: DiscordChannelType.PUBLIC_THREAD,
          name: "intro-thread",
          parent_id: "550",
          position: 0,
        },
      ],
    );

    assert.equal(cache.hasHydratedGuildChannels("55"), true);
    const g55Channels = cache.listGuildChannels("55");
    assert.ok(g55Channels);
    assert.equal(g55Channels.guildName, "Invite Guild");
    assert.equal(g55Channels.totalChannels, 4);
    assert.deepEqual(
      g55Channels.categories.map((c) => c.id),
      ["551"],
    );
    assert.equal(g55Channels.categories[0]!.isCategory, true);
    assert.equal(g55Channels.categories[0]!.isThread, false);
    assert.deepEqual(
      g55Channels.channels.map((c) => c.id),
      ["550", "552"],
    );
    assert.equal(g55Channels.channels[0]!.isCategory, false);
    assert.equal(g55Channels.channels[0]!.isThread, false);
    assert.deepEqual(
      g55Channels.threads.map((t) => t.id),
      ["553"],
    );
    assert.equal(g55Channels.threads[0]!.isThread, true);
    assert.equal(g55Channels.threads[0]!.isCategory, false);

    // Calling upsertGuildChannels without threads preserves existing threads
    cache.upsertGuildChannels("55", [
      {
        id: "550",
        type: DiscordChannelType.GUILD_TEXT,
        name: "welcome-room",
        position: 0,
      },
    ]);
    const afterPartialChannelUpdate = cache.listGuildChannels("55");
    assert.ok(afterPartialChannelUpdate);
    assert.deepEqual(
      afterPartialChannelUpdate.channels.map((c) => c.id),
      ["550"],
    );
    assert.deepEqual(
      afterPartialChannelUpdate.threads.map((t) => t.id),
      ["553"],
    );

    // 5. extractChannelMembers: unique users ordered newest-first with guild nick/roles + DM recipients
    cache.handleGatewayDispatch("GUILD_MEMBER_ADD", {
      guild_id: "10",
      user: BOB,
      nick: "Bobby",
      roles: ["role-bob-1", "role-bob-2"],
      joined_at: "2026-05-01T00:00:00.000Z",
    });

    cache.mergeRestTailMessages("100", [
      makeMessage({
        id: "7001",
        channel_id: "100",
        guild_id: "10",
        author: ALICE,
        content: "first alice",
      }),
      {
        ...makeMessage({
          id: "7002",
          channel_id: "100",
          guild_id: "10",
          author: BOB,
          content: "bob msg",
        }),
      },
      // Message with embedded partial member updates Alice's nick/roles
      Object.assign(
        makeMessage({
          id: "7003",
          channel_id: "100",
          guild_id: "10",
          author: ALICE,
          content: "newer alice",
        }),
        { member: { nick: "AliceMsgNick", roles: ["role-alice-msg"] } },
      ),
      makeMessage({
        id: "7004",
        channel_id: "100",
        guild_id: "10",
        author: BOT_USER,
        content: "bot msg",
      }),
    ]);

    const extracted = cache.extractChannelMembers("100", 10);
    assert.deepEqual(
      extracted.map((m) => m.userId),
      [BOT_USER.id, ALICE.id, BOB.id],
    );
    assert.deepEqual(extracted[0]!.roleIds, ["500", "501"]);
    assert.equal(extracted[1]!.nickname, "AliceMsgNick");
    assert.deepEqual(extracted[1]!.roleIds, ["role-alice-msg"]);
    assert.equal(extracted[2]!.nickname, "Bobby");
    assert.deepEqual(extracted[2]!.roleIds, ["role-bob-1", "role-bob-2"]);
    assert.equal(extracted[2]!.joinedAt, "2026-05-01T00:00:00.000Z");

    // Limit cap & non-positive limit
    assert.equal(cache.extractChannelMembers("100", 2).length, 2);
    assert.deepEqual(cache.extractChannelMembers("100", 0), []);

    // GUILD_MEMBER_REMOVE clears cached guild member metadata
    cache.handleGatewayDispatch("GUILD_MEMBER_REMOVE", {
      guild_id: "10",
      user: BOB,
    });
    const bobAfterRemove = cache
      .extractChannelMembers("100", 10)
      .find((m) => m.userId === BOB.id);
    assert.equal(bobAfterRemove?.nickname, null);
    assert.deepEqual(bobAfterRemove?.roleIds, []);

    // DM channel includes recipient even without cached messages
    const dmMembers = cache.extractChannelMembers("dm-bob", 10);
    assert.deepEqual(
      dmMembers.map((m) => m.userId),
      [BOB.id],
    );
    assert.equal(dmMembers[0]!.username, "bob");
    assert.equal(dmMembers[0]!.nickname, null);
    assert.deepEqual(dmMembers[0]!.roleIds, []);
  });
});
