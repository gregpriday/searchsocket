import type { JsonLogEntry } from "../types";

export interface LoggerOptions {
  json?: boolean;
  verbose?: boolean;
  /** When true, all output (including info/event) is written to stderr instead of stdout. */
  stderrOnly?: boolean;
}

export class Logger {
  private readonly json: boolean;
  private readonly verbose: boolean;
  private readonly stderrOnly: boolean;

  constructor(opts: LoggerOptions = {}) {
    this.json = opts.json ?? false;
    this.verbose = opts.verbose ?? false;
    this.stderrOnly = opts.stderrOnly ?? false;
  }

  info(message: string): void {
    if (this.json) {
      return;
    }

    this.writeOut(`${message}\n`);
  }

  debug(message: string): void {
    if (!this.verbose) {
      return;
    }

    if (this.json) {
      this.logJson("debug", { message });
      return;
    }

    this.writeOut(`${message}\n`);
  }

  warn(message: string): void {
    if (this.json) {
      this.logJson("warn", { message });
      return;
    }

    process.stderr.write(`WARN: ${message}\n`);
  }

  error(message: string): void {
    if (this.json) {
      this.logJson("error", { message });
      return;
    }

    process.stderr.write(`ERROR: ${message}\n`);
  }

  event(event: string, data?: Record<string, unknown>): void {
    if (!this.json && !this.verbose) {
      return;
    }

    if (this.json) {
      this.logJson(event, data);
      return;
    }

    this.writeOut(`[${event}] ${data ? JSON.stringify(data) : ""}\n`);
  }

  private writeOut(text: string): void {
    if (this.stderrOnly) {
      process.stderr.write(text);
    } else {
      process.stdout.write(text);
    }
  }

  private logJson(event: string, data?: Record<string, unknown>): void {
    const entry: JsonLogEntry = {
      event,
      ts: new Date().toISOString(),
      data
    };

    this.writeOut(`${JSON.stringify(entry)}\n`);
  }
}
