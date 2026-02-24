const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BF_DIR = path.join(os.homedir(), '.browserforce');
const LOG_CDP_FILE_PATH = process.env.BROWSERFORCE_CDP_LOG_FILE_PATH || path.join(BF_DIR, 'cdp.jsonl');
const DEFAULT_MAX_STRING_LENGTH = 2000;

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

function createCdpLogger({ logFilePath, maxStringLength } = {}) {
  const resolvedLogFilePath = logFilePath || process.env.BROWSERFORCE_CDP_LOG_FILE_PATH || LOG_CDP_FILE_PATH;
  fs.mkdirSync(path.dirname(resolvedLogFilePath), { recursive: true });
  fs.writeFileSync(resolvedLogFilePath, '');

  const resolvedMaxStringLength = resolveMaxStringLength(maxStringLength);
  let queue = Promise.resolve();

  return {
    logFilePath: resolvedLogFilePath,
    log(entry) {
      const line = JSON.stringify(entry, createTruncatingCircularReplacer(resolvedMaxStringLength));
      queue = queue
        .then(() => fs.promises.appendFile(resolvedLogFilePath, `${line}\n`))
        .catch(() => {});
    },
  };
}

module.exports = {
  LOG_CDP_FILE_PATH,
  createCdpLogger,
};
