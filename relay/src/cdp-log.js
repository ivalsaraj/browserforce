const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BF_DIR = path.join(os.homedir(), '.browserforce');
const LOG_CDP_FILE_PATH = process.env.BROWSERFORCE_CDP_LOG_FILE_PATH || path.join(BF_DIR, 'cdp.jsonl');
const DEFAULT_MAX_STRING_LENGTH = 2000;
const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

function chmodBestEffort(filePath, mode) {
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Best effort only: some platforms/filesystems do not support POSIX modes.
  }
}

function resolveMaxStringLength(maxStringLength) {
  if (Number.isFinite(maxStringLength) && maxStringLength > 0) {
    return Math.floor(maxStringLength);
  }
  const fromEnv = Number(process.env.BROWSERFORCE_CDP_LOG_MAX_STRING_LENGTH);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_MAX_STRING_LENGTH;
}

function resolveMaxFileSizeBytes(maxFileSizeBytes) {
  if (Number.isFinite(maxFileSizeBytes) && maxFileSizeBytes > 0) {
    return Math.floor(maxFileSizeBytes);
  }
  const fromEnv = Number(process.env.BROWSERFORCE_CDP_LOG_MAX_BYTES);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_MAX_FILE_SIZE_BYTES;
}

function truncateString(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  const truncatedCount = value.length - maxLength;
  return `${value.slice(0, maxLength)}...[truncated ${truncatedCount} chars]`;
}

function createTruncatingCircularReplacer(maxStringLength) {
  const seen = new WeakSet();
  return (_key, value) => {
    if (typeof value === 'string') {
      return truncateString(value, maxStringLength);
    }
    if (value && typeof value === 'object') {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  };
}

function createCdpLogger({ logFilePath, maxStringLength, maxFileSizeBytes } = {}) {
  const resolvedLogFilePath = logFilePath || process.env.BROWSERFORCE_CDP_LOG_FILE_PATH || LOG_CDP_FILE_PATH;
  const logDir = path.dirname(resolvedLogFilePath);
  fs.mkdirSync(logDir, { recursive: true });
  chmodBestEffort(logDir, 0o700);
  fs.writeFileSync(resolvedLogFilePath, '', { mode: 0o600 });
  chmodBestEffort(resolvedLogFilePath, 0o600);

  const resolvedMaxStringLength = resolveMaxStringLength(maxStringLength);
  const resolvedMaxFileSizeBytes = resolveMaxFileSizeBytes(maxFileSizeBytes);
  let currentFileSizeBytes = 0;
  let queue = Promise.resolve();

  return {
    logFilePath: resolvedLogFilePath,
    log(entry) {
      const line = JSON.stringify(entry, createTruncatingCircularReplacer(resolvedMaxStringLength));
      const encodedLine = `${line}\n`;
      const lineSizeBytes = Buffer.byteLength(encodedLine);
      if (lineSizeBytes > resolvedMaxFileSizeBytes) {
        return;
      }
      queue = queue
        .then(async () => {
          if (currentFileSizeBytes + lineSizeBytes > resolvedMaxFileSizeBytes) {
            await fs.promises.truncate(resolvedLogFilePath, 0);
            currentFileSizeBytes = 0;
          }
          await fs.promises.appendFile(resolvedLogFilePath, encodedLine);
          currentFileSizeBytes += lineSizeBytes;
        })
        .catch(() => {});
    },
  };
}

module.exports = {
  LOG_CDP_FILE_PATH,
  createCdpLogger,
};
