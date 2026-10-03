// Transports: how protocol messages cross a room.
//
// Two implementations behind one small interface -- send(message, { to }),
// onMessage, close, and a `kind` tag -- so the client and host never branch
// on the medium:
//
// - BroadcastChannelTransport: same browser profile (multiple tabs). Zero
//   setup, perfect for the automation harness and for "two players, one
//   machine" dev rooms; also the LAN dev fallback when no LiveKit server
//   is configured.
// - LiveKitTransport: a LiveKit room over WebRTC data channels. One WS URL
//   and one JWT token per participant (phase 6 mints these). Messages ride
//   the room's data channel: unreliable for high-rate pose/ping traffic,
//   reliable for everything that decides the match.

import { MESSAGE } from './protocol.js';

const LOSSY_TYPES = new Set([MESSAGE.POSE, MESSAGE.PING, MESSAGE.PONG]);

function isLossy(message) {
  return LOSSY_TYPES.has(message?.type);
}

/**
 * Addressing wrapper for transports that can only broadcast: the sender
 * marks who the packet is for; every receiver drops what is not theirs.
 * { r, to, m } -- r for "routed", m for the payload message.
 */
function routeEnvelope(message, to) {
  return to ? { r: 1, to: String(to), m: message } : message;
}

function unwrapRouted(data, selfId) {
  if (data && data.r === 1 && typeof data.to === 'string') {
    if (data.to !== selfId) return null;
    return data.m;
  }
  return data;
}

export class BroadcastChannelTransport {
  constructor({ channelName, selfId, onMessage } = {}) {
    if (typeof BroadcastChannel !== 'function') throw new Error('BroadcastChannel unavailable');
    this.kind = 'broadcast';
    this.selfId = String(selfId);
    this.onMessage = onMessage;
    this.closed = false;
    this.channel = new BroadcastChannel(channelName);
    this.channel.onmessage = (event) => {
      if (this.closed) return;
      const message = unwrapRouted(event?.data, this.selfId);
      if (message) this.onMessage?.(message, null);
    };
  }

  /** `to` targets one peer by id; every peer receives and filters. */
  send(message, { to = null } = {}) {
    if (this.closed) return false;
    try {
      this.channel.postMessage(routeEnvelope(message, to));
      return true;
    } catch {
      // Structured-clone failures would be a caller bug, not a net error.
      return false;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.channel.onmessage = null;
    try { this.channel.close(); } catch { /* already closed */ }
  }
}

export class LiveKitTransport {
  /**
   * `livekitModule` lets tests inject a stub of the CDN module; production
   * resolves it lazily so the game never imports livekit-client until a
   * networked room actually starts.
   */
  constructor({ url, token, identity, onMessage, onStatus = null, livekitModule = null } = {}) {
    if (!url) throw new Error('LiveKitTransport requires a url');
    if (!token) throw new Error('LiveKitTransport requires a token');
    this.kind = 'livekit';
    this.url = String(url);
    this.token = String(token);
    this.selfId = String(identity);
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.closed = false;
    this.room = null;
    this.livekitModule = livekitModule;
  }

  async connect() {
    // Resolved through the page's importmap (pinned livekit-client@2.22.3),
    // so the SDK only loads when a LiveKit room actually starts.
    const livekit = this.livekitModule ?? await import('livekit-client');
    const { Room } = livekit;
    this.room = new Room({ adaptiveStream: false, dynacast: false });
    this.room.on('dataReceived', (payload) => {
      if (this.closed) return;
      try {
        const text = new TextDecoder().decode(payload);
        const routed = JSON.parse(text);
        const message = unwrapRouted(routed, this.selfId);
        if (message) this.onMessage?.(message, null);
      } catch { // A malformed frame is never fatal on a shared medium.
      }
    });
    const status = (state) => { if (!this.closed) this.onStatus?.(state); };
    this.room.on('connected', () => status('connected'));
    this.room.on('reconnecting', () => status('reconnecting'));
    this.room.on('reconnected', () => status('connected'));
    this.room.on('disconnected', () => status('disconnected'));
    await this.room.connect(this.url, this.token);
    return this.room;
  }

  /** Identity-based unicast when `to` is set, else the whole room. */
  send(message, { to = null } = {}) {
    if (this.closed || !this.room?.localParticipant) return false;
    const bytes = new TextEncoder().encode(JSON.stringify(routeEnvelope(message, to)));
    try {
      this.room.localParticipant.publishData(bytes, {
        reliable: !isLossy(message),
        ...(to ? { destinationIdentities: [String(to)] } : {}),
      });
      return true;
    } catch {
      return false;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.room?.disconnect(); } catch { /* already gone */ }
    this.room = null;
  }
}

/**
 * ESM entry of livekit-client, as served by the importmap. Tests inject a
 * stub via `livekitModule`; production resolves the bare specifier lazily so
 * the game never loads the SDK in solo play.
 */
export const LIVEKIT_MODULE_URL = 'livekit-client';

/** Builds the transport the page asked for. Kept out of the page's imports. */
export function createTransport({ mode = 'broadcast', ...options } = {}) {
  if (mode === 'livekit') return new LiveKitTransport(options);
  return new BroadcastChannelTransport(options);
}

export default { BroadcastChannelTransport, LiveKitTransport, createTransport };
