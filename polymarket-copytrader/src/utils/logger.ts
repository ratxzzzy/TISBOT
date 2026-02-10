// ANSI color codes for terminal output
const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightCyan: "\x1b[96m",
} as const;

type LogLevel =
  | "INFO"
  | "SUCCESS"
  | "ERROR"
  | "TRADE"
  | "COPY"
  | "BUDGET"
  | "DEBUG"
  | "WARN";

const LEVEL_CONFIG: Record<LogLevel, { color: string; emoji: string }> = {
  INFO: { color: COLORS.blue, emoji: "ℹ️" },
  SUCCESS: { color: COLORS.brightGreen, emoji: "✅" },
  ERROR: { color: COLORS.red, emoji: "❌" },
  TRADE: { color: COLORS.magenta, emoji: "🎯" },
  COPY: { color: COLORS.cyan, emoji: "📋" },
  BUDGET: { color: COLORS.brightYellow, emoji: "💰" },
  DEBUG: { color: COLORS.gray, emoji: "🔍" },
  WARN: { color: COLORS.yellow, emoji: "⚠️" },
};

function getTimestamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

function formatMessage(level: LogLevel, message: string, data?: unknown): string {
  const { color, emoji } = LEVEL_CONFIG[level];
  const timestamp = `${COLORS.gray}[${getTimestamp()}]${COLORS.reset}`;
  const levelTag = `${color}[${level}]${COLORS.reset}`;
  const dataStr = data !== undefined ? ` ${COLORS.gray}${JSON.stringify(data)}${COLORS.reset}` : "";
  return `${timestamp} ${levelTag} ${emoji} ${message}${dataStr}`;
}

export const logger = {
  info(message: string, data?: unknown): void {
    console.log(formatMessage("INFO", message, data));
  },

  success(message: string, data?: unknown): void {
    console.log(formatMessage("SUCCESS", message, data));
  },

  error(message: string, data?: unknown): void {
    console.error(formatMessage("ERROR", message, data));
  },

  trade(message: string, data?: unknown): void {
    console.log(formatMessage("TRADE", message, data));
  },

  copy(message: string, data?: unknown): void {
    console.log(formatMessage("COPY", message, data));
  },

  budget(message: string, data?: unknown): void {
    console.log(formatMessage("BUDGET", message, data));
  },

  debug(message: string, data?: unknown): void {
    if (process.env["LOG_LEVEL"] === "debug") {
      console.log(formatMessage("DEBUG", message, data));
    }
  },

  warn(message: string, data?: unknown): void {
    console.warn(formatMessage("WARN", message, data));
  },
};
