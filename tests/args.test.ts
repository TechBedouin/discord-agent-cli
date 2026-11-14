import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CliParseError,
  formatHelpText,
  hasJsonFlagInArgv,
  parseCliArgs,
} from "../dist/cli/args.js";
import {
  DEFAULT_CHANNEL_MEMBERS_LIMIT,
  DEFAULT_READ_LIMIT,
  MAX_CHANNEL_MEMBERS_LIMIT,
} from "../dist/shared/config.js";

function assertCliParseError(argv: string[], pattern?: RegExp): CliParseError {
  let caught: unknown;
  assert.throws(
    () => parseCliArgs(argv),
    (err: unknown) => {
      caught = err;
      return err instanceof CliParseError;
    },
  );
  assert.ok(caught instanceof CliParseError);
  assert.equal(caught.exitCode, 2);
  assert.equal(caught.code, "BAD_REQUEST");
  if (pattern !== undefined) {
    assert.match(caught.message, pattern);
  }
  return caught;
}

describe("cli/args parseCliArgs", () => {
  describe("global flags & -- end-of-flags", () => {
    it("accepts --json, --port, and --home both before and after subcommands", () => {
      assert.deepEqual(
        parseCliArgs(["--json", "--port", "48000", "--home", "/tmp/dcli", "status"]),
        {
          command: "status",
          globals: { json: true, port: 48000, home: "/tmp/dcli" },
        },
      );

      assert.deepEqual(
        parseCliArgs(["status", "--json", "--port=0", "--home=C:\\discord-cli"]),
        {
          command: "status",
          globals: { json: true, port: 0, home: "C:\\discord-cli" },
        },
      );

      assert.deepEqual(
        parseCliArgs(["send", "1234567890", "hello", "--json", "--port", "65535"]),
        {
          command: "send",
          globals: { json: true, port: 65535 },
          channelId: "1234567890",
          content: "hello",
        },
      );
    });

    it("detects --json only before -- in hasJsonFlagInArgv", () => {
      assert.equal(hasJsonFlagInArgv(["--json", "status"]), true);
      assert.equal(hasJsonFlagInArgv(["status", "--json"]), true);
      assert.equal(hasJsonFlagInArgv(["send", "123", "--", "--json"]), false);
      assert.equal(hasJsonFlagInArgv(["status"]), false);
    });

    it("supports --help/-h and --version/-v with globals", () => {
      assert.deepEqual(parseCliArgs(["--help", "--json"]), {
        command: "help",
        globals: { json: true },
      });
      assert.deepEqual(parseCliArgs(["status", "-h"]), {
        command: "help",
        globals: { json: false },
      });
      assert.deepEqual(parseCliArgs(["-v"]), {
        command: "version",
        globals: { json: false },
      });
      assert.deepEqual(parseCliArgs(["--version", "--port=47832"]), {
        command: "version",
        globals: { json: false, port: 47832 },
      });
      const help = formatHelpText();
      assert.match(help, /discord-cli/);
      assert.match(help, /join <invite_code_or_url>/);
      assert.match(help, /guilds/);
      assert.match(help, /channels <guild_id>/);
      assert.match(help, /members <channel_id> \[--limit N\]/);
      assert.match(help, /dm <user_id> <message\.\.\.> \[--typing\]/);
      assert.match(help, /\bdms\b/);
      assert.match(help, /send <channel_id> <message\.\.\.> \[--reply <message_id>\] \[--typing\]/);
      assert.match(help, /DISCORD_AUTH_MODE/);
      assert.match(help, /DISCORD_AUTO_TYPING/);
    });

    it("handles -- end-of-flags for message text starting with -", () => {
      assert.deepEqual(
        parseCliArgs([
          "--json",
          "send",
          "123456789",
          "--reply=987654321",
          "--",
          "-leading-dash",
          "--not-a-flag",
          "--json",
        ]),
        {
          command: "send",
          globals: { json: true },
          channelId: "123456789",
          content: "-leading-dash --not-a-flag --json",
          replyToMessageId: "987654321",
        },
      );

      assert.deepEqual(parseCliArgs(["send", "123456789", "-"]), {
        command: "send",
        globals: { json: false },
        channelId: "123456789",
        content: "-",
      });
    });

    it("validates --port and --home and rejects invalid global values with exitCode 2", () => {
      assertCliParseError(["--port", "-1", "status"], /port/i);
      assertCliParseError(["--port", "65536", "status"], /port/i);
      assertCliParseError(["--port", "abc", "status"], /port/i);
      assertCliParseError(["--port"], /Missing value/);
      assertCliParseError(["--home", "   ", "status"], /--home/);
      assertCliParseError(["--home"], /Missing value/);
      assertCliParseError(["--json=true", "status"], /does not accept a value/);
    });
  });

  describe("subcommands & options", () => {
    it("parses unread [--mentions-only] [--no-dms]", () => {
      assert.deepEqual(parseCliArgs(["unread"]), {
        command: "unread",
        globals: { json: false },
        mentionsOnly: false,
        includeDms: true,
      });

      assert.deepEqual(
        parseCliArgs(["unread", "--mentions-only", "--no-dms", "--json"]),
        {
          command: "unread",
          globals: { json: true },
          mentionsOnly: true,
          includeDms: false,
        },
      );
    });

    it("parses read <channel_id> [--limit N] [--mark-read] [--before] [--after]", () => {
      assert.deepEqual(parseCliArgs(["read", "111222333"]), {
        command: "read",
        globals: { json: false },
        channelId: "111222333",
        limit: DEFAULT_READ_LIMIT,
        markRead: false,
      });

      assert.deepEqual(
        parseCliArgs([
          "read",
          "111222333",
          "--limit",
          "100",
          "--mark-read",
          "--before",
          "999",
          "--after=100",
        ]),
        {
          command: "read",
          globals: { json: false },
          channelId: "111222333",
          limit: 100,
          markRead: true,
          before: "999",
          after: "100",
        },
      );
    });

    it("parses send <channel_id> <message...> [--reply] [--typing]", () => {
      assert.deepEqual(
        parseCliArgs(["send", "555", "hello", "discord", "world", "--reply", "777"]),
        {
          command: "send",
          globals: { json: false },
          channelId: "555",
          content: "hello discord world",
          replyToMessageId: "777",
        },
      );

      assert.deepEqual(
        parseCliArgs([
          "send",
          "555",
          "--typing",
          "--reply=777",
          "--",
          "-hello",
        ]),
        {
          command: "send",
          globals: { json: false },
          channelId: "555",
          content: "-hello",
          replyToMessageId: "777",
          typing: true,
        },
      );
    });

    it("parses join <invite_code_or_url> for raw codes and invite URLs", () => {
      assert.deepEqual(parseCliArgs(["join", "abcXYZ123"]), {
        command: "join",
        globals: { json: false },
        invite: "abcXYZ123",
      });

      assert.deepEqual(
        parseCliArgs(["join", "discord.gg/xyz-99", "--json"]),
        {
          command: "join",
          globals: { json: true },
          invite: "xyz-99",
        },
      );

      assert.deepEqual(
        parseCliArgs([
          "join",
          "https://discord.com/invite/xyz?event=1",
        ]),
        {
          command: "join",
          globals: { json: false },
          invite: "xyz",
        },
      );

      assert.deepEqual(
        parseCliArgs([
          "join",
          "http://ptb.discordapp.com/invite/my_server/#welcome",
        ]),
        {
          command: "join",
          globals: { json: false },
          invite: "my_server",
        },
      );
    });

    it("parses guilds, channels <guild_id>, and members <channel_id> [--limit N]", () => {
      assert.deepEqual(parseCliArgs(["guilds", "--json"]), {
        command: "guilds",
        globals: { json: true },
      });

      assert.deepEqual(parseCliArgs(["channels", "9876543210"]), {
        command: "channels",
        globals: { json: false },
        guildId: "9876543210",
      });

      assert.deepEqual(parseCliArgs(["members", "111222333"]), {
        command: "members",
        globals: { json: false },
        channelId: "111222333",
        limit: DEFAULT_CHANNEL_MEMBERS_LIMIT,
      });

      assert.deepEqual(
        parseCliArgs(["members", "111222333", "--limit", "1", "--json"]),
        {
          command: "members",
          globals: { json: true },
          channelId: "111222333",
          limit: 1,
        },
      );

      assert.deepEqual(
        parseCliArgs([
          "members",
          "111222333",
          `--limit=${MAX_CHANNEL_MEMBERS_LIMIT}`,
        ]),
        {
          command: "members",
          globals: { json: false },
          channelId: "111222333",
          limit: MAX_CHANNEL_MEMBERS_LIMIT,
        },
      );
    });

    it("parses dms and dm <user_id> <message...> [--typing]", () => {
      assert.deepEqual(parseCliArgs(["dms"]), {
        command: "dms",
        globals: { json: false },
      });

      assert.deepEqual(parseCliArgs(["dms", "--json"]), {
        command: "dms",
        globals: { json: true },
      });

      assert.deepEqual(
        parseCliArgs(["dm", "444555666", "hey", "there"]),
        {
          command: "dm",
          globals: { json: false },
          userId: "444555666",
          content: "hey there",
        },
      );

      assert.deepEqual(
        parseCliArgs([
          "--json",
          "dm",
          "444555666",
          "--typing",
          "--",
          "-starts-with-dash",
          "again",
        ]),
        {
          command: "dm",
          globals: { json: true },
          userId: "444555666",
          content: "-starts-with-dash again",
          typing: true,
        },
      );
    });

    it("parses react <channel_id> <message_id> <emoji> [--remove]", () => {
      assert.deepEqual(parseCliArgs(["react", "10", "20", "🔥"]), {
        command: "react",
        globals: { json: false },
        channelId: "10",
        messageId: "20",
        emoji: "🔥",
        remove: false,
      });

      assert.deepEqual(
        parseCliArgs(["react", "10", "20", " <:party:999> ", "--remove", "--json"]),
        {
          command: "react",
          globals: { json: true },
          channelId: "10",
          messageId: "20",
          emoji: "<:party:999>",
          remove: true,
        },
      );
    });

    it("parses watch <channel_id> [--events]", () => {
      assert.deepEqual(parseCliArgs(["watch", "12345"]), {
        command: "watch",
        globals: { json: false },
        channelId: "12345",
      });

      assert.deepEqual(
        parseCliArgs([
          "watch",
          "12345",
          "--events",
          "message_create, reaction_add, message_create",
        ]),
        {
          command: "watch",
          globals: { json: false },
          channelId: "12345",
          events: ["message_create", "reaction_add"],
        },
      );
    });

    it("parses daemon start|stop|status|run", () => {
      assert.deepEqual(parseCliArgs(["daemon", "start"]), {
        command: "daemon",
        subcommand: "start",
        globals: { json: false },
        foreground: false,
      });
      assert.deepEqual(parseCliArgs(["daemon", "start", "--foreground", "--json"]), {
        command: "daemon",
        subcommand: "start",
        globals: { json: true },
        foreground: true,
      });
      assert.deepEqual(parseCliArgs(["daemon", "stop"]), {
        command: "daemon",
        subcommand: "stop",
        globals: { json: false },
      });
      assert.deepEqual(parseCliArgs(["daemon", "status"]), {
        command: "daemon",
        subcommand: "status",
        globals: { json: false },
      });
      assert.deepEqual(parseCliArgs(["daemon", "run"]), {
        command: "daemon",
        subcommand: "run",
        globals: { json: false },
      });
    });
  });

  describe("CliParseError validation cases (exitCode = 2)", () => {
    it("rejects missing, unknown, or malformed arguments and flags", () => {
      assertCliParseError([], /Missing command/);
      assertCliParseError(["bogus"], /Unknown command/);
      assertCliParseError(["status", "extra"], /Unexpected argument/);
      assertCliParseError(["status", "--limit", "5"], /not valid for command "status"/);
      assertCliParseError(["unread", "extra"], /Unexpected argument/);
      assertCliParseError(["unread", "--mark-read"], /not valid for command "unread"/);

      assertCliParseError(["read"], /Missing required <channel_id>/);
      assertCliParseError(["read", "not-a-snowflake"], /Invalid channel_id/);
      assertCliParseError(["read", "123", "extra"], /Unexpected extra argument/);
      assertCliParseError(["read", "123", "--limit", "0"], /Invalid --limit/);
      assertCliParseError(["read", "123", "--limit", "101"], /Invalid --limit/);
      assertCliParseError(["read", "123", "--limit", "ten"], /Invalid --limit/);
      assertCliParseError(["read", "123", "--before", "abc"], /Invalid --before/);
      assertCliParseError(["read", "123", "--after", "abc"], /Invalid --after/);

      assertCliParseError(["send"], /Missing required/);
      assertCliParseError(["send", "abc", "hi"], /Invalid channel_id/);
      assertCliParseError(["send", "123"], /Missing required <message>/);
      assertCliParseError(["send", "123", "   "], /must not be empty/);
      assertCliParseError(["send", "123", "x".repeat(2001)], /exceeds 2000/);
      assertCliParseError(["send", "123", "-oops"], /Unknown flag "-oops"/);
      assertCliParseError(["send", "123", "hi", "--reply", "bad"], /Invalid --reply/);
      assertCliParseError(["send", "123", "hi", "--typing=true"], /does not accept a value/);
      assertCliParseError(["send", "123", "hi", "--limit", "5"], /not valid for command "send"/);

      assertCliParseError(["join"], /Missing required <invite_code_or_url>/);
      assertCliParseError(["join", "abc", "extra"], /Unexpected extra argument/);
      assertCliParseError(["join", "https://example.com/invite/xyz"], /Unsupported invite URL host/);
      assertCliParseError(["join", "https://discord.com/channels/123"], /Invalid Discord invite URL/);
      assertCliParseError(["join", "bad!invite"], /Invalid Discord invite code/);
      assertCliParseError(["join", "abc", "--typing"], /not valid for command "join"/);

      assertCliParseError(["guilds", "extra"], /Unexpected argument/);
      assertCliParseError(["guilds", "--limit", "10"], /not valid for command "guilds"/);
      assertCliParseError(["guilds", "--typing"], /not valid for command "guilds"/);

      assertCliParseError(["channels"], /Missing required <guild_id>/);
      assertCliParseError(["channels", "not-snowflake"], /Invalid guild_id/);
      assertCliParseError(["channels", "123", "extra"], /Unexpected extra argument/);
      assertCliParseError(["channels", "123", "--limit", "10"], /not valid for command "channels"/);

      assertCliParseError(["members"], /Missing required <channel_id>/);
      assertCliParseError(["members", "bad"], /Invalid channel_id/);
      assertCliParseError(["members", "123", "extra"], /Unexpected extra argument/);
      assertCliParseError(["members", "123", "--limit", "0"], /Invalid --limit/);
      assertCliParseError(["members", "123", "--limit", "1001"], /Invalid --limit/);
      assertCliParseError(["members", "123", "--limit", "ten"], /Invalid --limit/);
      assertCliParseError(["members", "123", "--limit"], /Missing value/);
      assertCliParseError(["members", "123", "--typing"], /not valid for command "members"/);

      assertCliParseError(["dms", "extra"], /Unexpected argument/);
      assertCliParseError(["dms", "--typing"], /not valid for command "dms"/);

      assertCliParseError(["dm"], /Missing required <user_id> and <message>/);
      assertCliParseError(["dm", "bad", "hi"], /Invalid user_id/);
      assertCliParseError(["dm", "123"], /Missing required <message>/);
      assertCliParseError(["dm", "123", "   "], /must not be empty/);
      assertCliParseError(["dm", "123", "x".repeat(2001)], /exceeds 2000/);
      assertCliParseError(["dm", "123", "-oops"], /Unknown flag "-oops"/);
      assertCliParseError(["dm", "123", "hi", "--reply", "456"], /not valid for command "dm"/);
      assertCliParseError(["dm", "123", "hi", "--typing=false"], /does not accept a value/);

      assertCliParseError(["read", "123", "--typing"], /not valid for command "read"/);

      assertCliParseError(["react", "123", "456"], /requires/);
      assertCliParseError(["react", "123", "456", "👍", "extra"], /Unexpected extra/);
      assertCliParseError(["react", "123", "456", "   "], /Emoji must not be empty/);
      assertCliParseError(["react", "bad", "456", "👍"], /Invalid channel_id/);
      assertCliParseError(["react", "123", "bad", "👍"], /Invalid message_id/);

      assertCliParseError(["watch"], /Missing required <channel_id>/);
      assertCliParseError(["watch", "bad"], /Invalid channel_id/);
      assertCliParseError(["watch", "123", "extra"], /Unexpected extra/);
      assertCliParseError(["watch", "123", "--events", "unknown_ev"], /Unknown watch event/);
      assertCliParseError(["watch", "123", "--events", " , "], /at least one valid event/);

      assertCliParseError(["daemon"], /Missing daemon subcommand/);
      assertCliParseError(["daemon", "restart"], /Unknown daemon subcommand/);
      assertCliParseError(["daemon", "stop", "extra"], /Unexpected extra/);
      assertCliParseError(["daemon", "stop", "--foreground"], /not valid for command "daemon stop"/);
    });
  });
});
