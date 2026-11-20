/**
 * Errors that are safe to surface to API clients.
 */
export class BridgeError extends Error {
  constructor(message, { status = 500, code = 'internal_error', details } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class PairingTimeoutError extends BridgeError {
  constructor(message = 'Timed out waiting for WhatsApp to provide a QR or pairing code') {
    super(message, { status: 504, code: 'pairing_timeout' });
    this.name = 'PairingTimeoutError';
  }
}

export class NotConnectedError extends BridgeError {
  constructor() {
    super('The WhatsApp session is not connected', {
      status: 409,
      code: 'not_connected',
    });
    this.name = 'NotConnectedError';
  }
}
