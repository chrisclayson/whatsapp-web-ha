import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

import { BridgeError, PairingTimeoutError } from './errors.js';
import { safeEqual } from './util.js';

const MAX_BODY_BYTES = 1_000_000;
const MAX_WS_BUFFER = 2_000_000;

/**
 * HTTP + WebSocket API for the Home Assistant integration.
 *
 * The server is deliberately dependency-light: Node's http module and `ws`.
 * Every /api/* route requires the bearer token; /healthz is unauthenticated so
 * container health checks work without exposing any account data.
 */
export function createBridgeServer({ session, config, logger }) {
  const clients = new Set();
  const wss = new WebSocketServer({ noServer: true, clientTracking: false });

  const corsHeaders = config.corsOrigin
    ? {
        'access-control-allow-origin': config.corsOrigin,
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      }
    : {};

  function sendJson(res, status, payload) {
    if (res.headersSent) return;
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      ...corsHeaders,
    });
    res.end(body);
  }

  function sendError(res, err) {
    if (err instanceof PairingTimeoutError || err instanceof BridgeError) {
      sendJson(res, err.status, {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      });
      return;
    }
    logger?.error({ err }, 'unhandled request error');
    sendJson(res, 500, {
      error: { code: 'internal_error', message: 'Internal bridge error' },
    });
  }

  function authorized(req, url) {
    if (!config.token) return true;
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const query = url.searchParams.get('token') ?? '';
    return safeEqual(bearer, config.token) || safeEqual(query, config.token);
  }

  async function readJson(req, { allowEmpty = false } = {}) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        throw new BridgeError('Request body is too large', {
          status: 413,
          code: 'body_too_large',
        });
      }
      chunks.push(chunk);
    }
    if (!size) {
      if (allowEmpty) return {};
      throw new BridgeError('A JSON body is required', {
        status: 400,
        code: 'invalid_body',
      });
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new BridgeError('Request body is not valid JSON', {
        status: 400,
        code: 'invalid_json',
      });
    }
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    if (path === '/healthz' && method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        status: session.status,
        instance_id: session.instanceId,
        version: config.version,
      });
      return;
    }

    if (!authorized(req, url)) {
      sendJson(res, 401, {
        error: { code: 'unauthorized', message: 'Invalid or missing API token' },
      });
      return;
    }

    switch (`${method} ${path}`) {
      case 'GET /api/state':
        sendJson(res, 200, session.getState());
        return;

      case 'GET /api/chats':
        sendJson(res, 200, { chats: session.getChats() });
        return;

      case 'GET /api/version':
        sendJson(res, 200, {
          version: config.version,
          instance_id: session.instanceId,
        });
        return;

      case 'POST /api/pair/start': {
        const body = await readJson(req, { allowEmpty: true });
        const method = body.method === 'phone' ? 'phone' : 'qr';
        if (method === 'phone' && !body.phone) {
          throw new BridgeError('phone is required for phone pairing', {
            status: 400,
            code: 'invalid_phone',
          });
        }
        const state = await session.start({
          method,
          phone: body.phone,
          timeoutMs: 25000,
        });
        sendJson(res, 200, state);
        return;
      }

      case 'POST /api/pair/cancel':
        await session.cancelPairing();
        sendJson(res, 200, { ok: true });
        return;

      case 'POST /api/logout':
        await session.logout();
        sendJson(res, 200, { ok: true });
        return;

      case 'POST /api/send': {
        const body = await readJson(req);
        const result = await session.sendText({
          to: body.to,
          text: body.text ?? body.message,
        });
        sendJson(res, 200, result);
        return;
      }

      case 'POST /api/read': {
        const body = await readJson(req);
        const result = await session.markRead({
          chat: body.chat,
          messageIds: body.message_ids ?? null,
        });
        sendJson(res, 200, result);
        return;
      }

      case 'POST /api/typing': {
        const body = await readJson(req);
        const result = await session.sendTyping({
          chat: body.chat,
          state: body.state,
        });
        sendJson(res, 200, result);
        return;
      }

      default:
        sendJson(res, 404, {
          error: { code: 'not_found', message: 'Unknown endpoint' },
        });
    }
  }

  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((err) => sendError(res, err));
  });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!authorized(req, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'ping') {
          ws.send(
            JSON.stringify({
              type: 'pong',
              data: {},
              at: new Date().toISOString(),
            }),
          );
        }
      } catch {
        // Ignore malformed client frames.
      }
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));

    ws.send(
      JSON.stringify({
        type: 'hello',
        data: session.getState(),
        at: new Date().toISOString(),
      }),
    );
  });

  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref?.();

  const unsubscribe = session.subscribe((frame) => {
    const payload = JSON.stringify(frame);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < MAX_WS_BUFFER) {
        ws.send(payload);
      }
    }
  });

  async function close() {
    clearInterval(heartbeat);
    unsubscribe();
    for (const ws of clients) {
      try {
        ws.close(1001, 'bridge shutting down');
      } catch {
        // ignore
      }
    }
    clients.clear();
    await new Promise((resolve) => wss.close(() => resolve()));
    await new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }

  return { server, close };
}
