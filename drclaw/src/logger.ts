/**
 * Dr. Claw — 日誌系統
 * 從 washin-api utils/logger.ts 獨立
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m', // 青色
  info: '\x1b[32m',  // 綠色
  warn: '\x1b[33m',  // 黃色
  error: '\x1b[31m', // 紅色
};
const RESET = '\x1b[0m';

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function shouldLog(level: LogLevel): boolean {
  return levels.indexOf(level) >= levels.indexOf(currentLevel);
}

function formatTime(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * 建立指定名稱的 logger
 */
export function createLogger(name: string) {
  const prefix = `[${name}]`;

  return {
    debug: (msg: string, ...args: unknown[]) => {
      if (shouldLog('debug'))
        console.log(`${LOG_COLORS.debug}${formatTime()} DEBUG ${prefix}${RESET} ${msg}`, ...args);
    },
    info: (msg: string, ...args: unknown[]) => {
      if (shouldLog('info'))
        console.log(`${LOG_COLORS.info}${formatTime()} INFO  ${prefix}${RESET} ${msg}`, ...args);
    },
    warn: (msg: string, ...args: unknown[]) => {
      if (shouldLog('warn'))
        console.warn(`${LOG_COLORS.warn}${formatTime()} WARN  ${prefix}${RESET} ${msg}`, ...args);
    },
    error: (msg: string, ...args: unknown[]) => {
      if (shouldLog('error'))
        console.error(`${LOG_COLORS.error}${formatTime()} ERROR ${prefix}${RESET} ${msg}`, ...args);
    },
  };
}

export const logger = createLogger('DrClaw');
