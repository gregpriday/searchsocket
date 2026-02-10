import type { JsonLogEntry } from "../types";

export interface LoggerOptions {
  json?: boolean;
  verbose?: boolean;
}

export class Logger {
  private readonly json: boolean;
  private readonly verbose: boolean;

  constructor(opts: LoggerOptions = {}) {
    this.json = opts.json ?? false;
    this.verbose = opts.verbose ?? false;
  }

  info(message: string): void {
    if (this.json) {
      return;
    }

    process.stdout.write(`${message}\n`);
  }

  debug(message: string): void {
    if (!this.verbose) {
      return;
    }

    if (this.json) {
      this.logJson("debug", { message });
      return;
    }

    process.stdout.write(`${message}\n`);
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

    process.stdout.write(`[${event}] ${data ? JSON.stringify(data) : ""}\n`);
  }

  private logJson(event: string, data?: Record<string, unknown>): void {
    const entry: JsonLogEntry = {
      event,
      ts: new Date().toISOString(),
      data
    };

    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
}
