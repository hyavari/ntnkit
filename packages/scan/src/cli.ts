#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createMessage, ValidationError } from "@ntnkit/core";
import {
  scanMessages,
  hasCritical,
  DEFAULT_MAX_PAYLOAD_BYTES,
  type ScanFinding,
} from "./index.js";

export interface CliIo {
  readFileSync: (path: string) => Buffer;
  log: (line: string) => void;
  error: (line: string) => void;
}

const defaultIo: CliIo = {
  readFileSync: (path) => readFileSync(path),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

function usageMessage(): string {
  return `Usage: ntnkit-scan --payload-file <path> [--max-bytes N] [--json]`;
}

function printFindings(
  items: ScanFinding[],
  json: boolean,
  log: (line: string) => void,
): void {
  if (json) {
    log(JSON.stringify({ findings: items }, null, 2));
    return;
  }
  for (const f of items) {
    log(`${f.severity.toUpperCase()}\t${f.rule}\t${f.message}`);
  }
}

/** Run the CLI; returns a process exit code (0 ok, 1 critical findings, 2 usage/error). */
export function runCli(args: string[], io: CliIo = defaultIo): number {
  let payloadFile: string | undefined;
  let maxBytes = DEFAULT_MAX_PAYLOAD_BYTES;
  let asJson = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--payload-file") {
      const value = args[++i];
      if (!value) {
        io.error("error: --payload-file requires a path");
        return 2;
      }
      payloadFile = value;
    } else if (arg === "--max-bytes") {
      const value = args[++i];
      const n = Number(value);
      if (!value || !Number.isFinite(n) || n <= 0) {
        io.error("error: --max-bytes requires a positive number");
        return 2;
      }
      maxBytes = n;
    } else if (arg === "--json") {
      asJson = true;
    } else if (arg === "--help" || arg === "-h") {
      io.error(usageMessage());
      return 0;
    } else {
      io.error(`error: unknown argument ${arg}`);
      return 2;
    }
  }

  if (!payloadFile) {
    io.error(usageMessage());
    return 2;
  }

  let payload: Buffer;
  try {
    payload = io.readFileSync(payloadFile);
  } catch (err) {
    io.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  try {
    const message = createMessage({ payload });
    const findings = scanMessages([message], { maxPayloadBytes: maxBytes });
    printFindings(findings, asJson, io.log);
    return hasCritical(findings) ? 1 : 0;
  } catch (err) {
    if (err instanceof ValidationError) {
      io.error(`error: ${err.message}`);
      return 2;
    }
    io.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("/cli.js") ||
    process.argv[1].endsWith("/cli.ts") ||
    process.argv[1].endsWith("ntnkit-scan"));

if (isMain) {
  process.exit(runCli(process.argv.slice(2)));
}
