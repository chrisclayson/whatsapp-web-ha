import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function packageVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'),
    );
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function parseInteger(value, fallback, { min, max, name }) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const token = (env.BRIDGE_TOKEN ?? '').trim();
  const allowNoAuth = env.BRIDGE_ALLOW_NO_AUTH === '1';

  if (!token && !allowNoAuth) {
    throw new Error(
      'BRIDGE_TOKEN is not set. Set a long random token, or set ' +
        'BRIDGE_ALLOW_NO_AUTH=1 for isolated local testing.',
    );
  }
  if (token && token.length < 16) {
    throw new Error('BRIDGE_TOKEN must be at least 16 characters long');
  }

  const logLevel = (env.BRIDGE_LOG_LEVEL ?? 'info').toLowerCase();
  if (!['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'].includes(logLevel)) {
    throw new Error(`Unsupported BRIDGE_LOG_LEVEL: ${logLevel}`);
  }

  return {
    token,
    port: parseInteger(env.BRIDGE_PORT, 3000, {
      min: 1,
      max: 65535,
      name: 'BRIDGE_PORT',
    }),
    host: env.BRIDGE_HOST ?? '0.0.0.0',
    dataDir: path.resolve(env.BRIDGE_DATA_DIR ?? './data'),
    logLevel,
    autoConnect: env.BRIDGE_AUTO_CONNECT !== '0',
    maxChats: parseInteger(env.BRIDGE_MAX_CHATS, 500, {
      min: 10,
      max: 5000,
      name: 'BRIDGE_MAX_CHATS',
    }),
    corsOrigin: env.BRIDGE_CORS_ORIGIN ?? '',
    version: packageVersion(),
  };
}
