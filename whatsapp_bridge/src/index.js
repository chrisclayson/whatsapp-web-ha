import pino from 'pino';
import * as baileys from 'baileys';

import { loadConfig } from './config.js';
import { createBridgeServer } from './server.js';
import { WhatsAppSession } from './session.js';

const config = loadConfig();
const logger = pino({
  level: config.logLevel,
  base: { component: 'whatsapp-bridge' },
});

const baileysLogger = logger.child(
  { module: 'baileys' },
  {
    level:
      config.logLevel === 'trace' || config.logLevel === 'debug'
        ? 'debug'
        : 'warn',
  },
);

const deps = {
  makeWASocket: baileys.makeWASocket,
  useMultiFileAuthState: baileys.useMultiFileAuthState,
  fetchLatestBaileysVersion: baileys.fetchLatestBaileysVersion,
  Browsers: baileys.Browsers,
  DisconnectReason: baileys.DisconnectReason,
  normalizeMessageContent: baileys.normalizeMessageContent,
  WAMessageStatus: baileys.WAMessageStatus,
};

const session = new WhatsAppSession({
  dataDir: config.dataDir,
  logger,
  deps,
  config: { ...config, baileysLogger },
});

await session.init();

const { server, close } = createBridgeServer({ session, config, logger });

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(config.port, config.host, resolve);
});

logger.info(
  {
    host: config.host,
    port: config.port,
    version: config.version,
    dataDir: config.dataDir,
    authRequired: Boolean(config.token),
  },
  'WhatsApp bridge listening',
);

if (config.autoConnect) {
  void session.startAuto();
} else {
  logger.info('automatic connection disabled; waiting for /api/pair/start');
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  try {
    await close();
    await session.close();
  } catch (err) {
    logger.error({ err }, 'error while shutting down');
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'unhandled promise rejection');
});
