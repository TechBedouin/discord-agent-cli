#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HttpStatus,
  createIpcError,
  errorEnvelope,
  serializeJsonEnvelope,
} from "../shared/ipc-protocol.js";
import { IpcErrorCode } from "../shared/types.js";
import {
  CliParseError,
  hasJsonFlagInArgv,
  parseCliArgs,
} from "./args.js";
import { runCliCommand, type CliCommandDeps } from "./commands.js";

/**
 * CLI Entrypoint.
 */

export async function runCliMain(
  argv: readonly string[] = process.argv.slice(2),
  deps: CliCommandDeps = {},
): Promise<number> {
  const stderr = deps.stderr ?? process.stderr;
  const jsonRequested = hasJsonFlagInArgv(argv);

  try {
    const parsed = parseCliArgs(argv);
    return await runCliCommand(parsed, deps);
  } catch (err) {
    if (err instanceof CliParseError) {
      if (jsonRequested) {
        const payload = createIpcError(
          err.code,
          err.message,
          HttpStatus.BAD_REQUEST,
        );
        stderr.write(`${serializeJsonEnvelope(errorEnvelope(payload))}\n`);
      } else {
        stderr.write(`Error [${err.code}]: ${err.message}\n`);
      }
      return err.exitCode;
    }

    const message = err instanceof Error ? err.message : String(err);
    if (jsonRequested) {
      const payload = createIpcError(
        IpcErrorCode.INTERNAL_ERROR,
        message,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
      stderr.write(`${serializeJsonEnvelope(errorEnvelope(payload))}\n`);
    } else {
      stderr.write(`Error [${IpcErrorCode.INTERNAL_ERROR}]: ${message}\n`);
    }
    return 1;
  }
}

function isDirectCliExecution(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) {
    return false;
  }
  try {
    const selfPath = path.resolve(
      fs.realpathSync(fileURLToPath(import.meta.url)),
    );
    const entryPath = path.resolve(fs.realpathSync(entry));
    if (process.platform === "win32") {
      return selfPath.toLowerCase() === entryPath.toLowerCase();
    }
    return selfPath === entryPath;
  } catch {
    return false;
  }
}

if (isDirectCliExecution()) {
  runCliMain(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Fatal error: ${message}\n`);
      process.exitCode = 1;
    });
}
