// The network protocol: every packet that crosses a room is one of these.
//
// JSON v1. The host is authoritative: it simulates the match, the bots and
// the damage, and every guest is a puppet that reports its pose and fires
// "shots claimed" messages the host validates against lag-compensated
// hitboxes. Guests reconcile by receiving snapshots (poses + match state).
//
// Design rules:
// - Lossy where it can be (poses overwrite the previous sample), reliable
//   where it must be (join/leave, damage, death, match phase).
// - Every message carries the sender id and, where order matters, a
//   monotonic tick or seq so stale packets are dropped.
// - Pure data: no Three.js, no DOM, so node --test can exercise every rule.

export const PROTOCOL_VERSION = 1;

// Rates and budgets. Poses: 20 Hz * 8 fighters * ~60 B ~ 10 kB/s up per peer.
export const POSE_HZ = 20;
export const POSE_INTERVAL_MS = 1000 / POSE_HZ;
export const SNAPSHOT_HZ = 20;
export const SNAPSHOT_INTERVAL_MS = 1000 / SNAPSHOT_HZ;
// Rendering delay for remote bodies (see net/lag-comp.js, phase 4).
export const INTERP_DELAY_MS = 100;
export const HOST_TICK_HZ = 30;
export const HOST_TICK_INTERVAL_MS = 1000 / HOST_TICK_HZ;
export const MAX_PLAYERS = 8;
export const PING_INTERVAL_MS = 2000;
export const ROOM_CODE_LENGTH = 4;

// All message types, v1. Kept as a frozen map so transports can filter.
export const MESSAGE = Object.freeze({
  // Reliable, room-lifecycle.
  HELLO: 'hello', // guest -> host: want to join (name, livekit identity).
  WELCOME: 'welcome', // host -> guest: accepted (your id, room, roster, match).
  JOIN: 'join', // host -> all: a player joined (roster delta, broadcast).
  LEAVE: 'leave', // host -> all: a player left.
  ROOM_FULL: 'room-full', // host -> guest: rejected, room at capacity.
  PING: 'ping', // guest -> host RTT probe.
  PONG: 'pong', // host -> guest: echoes ping.seq.
  // Lossy, high rate.
  POSE: 'pose', // both ways: one fighter's transform (20 Hz, overwrite ok).
  SHOT: 'shot', // guest -> host: fired at (origin, dir, tick); also host -> guests for tracer/audio.
  // Reliable, gameplay.
  DAMAGE: 'damage', // host -> victim: you took this hit (amount, from, seq).
  DEATH: 'death', // host -> all: a fighter died (victim, killer, weapon).
  RESPAWN: 'respawn', // host -> victim (and broadcast): where you now stand.
  GRENADE: 'grenade', // guest -> host: thrown (origin, velocity); host relays for visuals.
  STATE: 'state', // host -> all: match phase, scores, feed (reliable, 5 Hz or on change).
});

const KNOWN_TYPES = new Set(Object.values(MESSAGE));
// Poses are lossy and plentiful: a flood of them must not log.
const NOISY_TYPES = new Set([MESSAGE.POSE, MESSAGE.PING, MESSAGE.PONG]);

const NAME_PATTERN = /^[\p{L}\p{N} _.-]{1,12}$/u;

/**
 * A room code: four unambiguous capitals (no I, L, O, U, 1, 0). Displayed
 * and typed by humans.
 */
export function makeRoomCode(random = Math.random) {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += alphabet[Math.floor(random() * alphabet.length) % alphabet.length];
  }
  return code;
}

export function isRoomCode(value) {
  return typeof value === 'string' && new RegExp(`^[A-Z2-9]{${ROOM_CODE_LENGTH}}$`).test(value);
}

/** Player ids: stable short tokens the host mints on join. */
export function makePlayerId(random = Math.random) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'p';
  for (let i = 0; i < 5; i += 1) id += alphabet[Math.floor(random() * alphabet.length) % alphabet.length];
  return id;
}

/** Host id is fixed: exactly one per room, always 'host'. */
export const HOST_ID = 'host';

export function sanitizeName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!NAME_PATTERN.test(name)) return 'PLAYER';
  return name.toUpperCase();
}

/**
 * Next slot for a paced sender (poses, snapshots, pings). While `previous`
 * is uninitialized (0) the first send fires immediately and the slot anchors
 * one interval ahead of `now`; afterwards the cadence holds its own rhythm
 * and only catches up to `now` when the sender stalled.
 */
export function advanceSlot(previous, now, interval) {
  if (!(previous > 0)) return now + interval;
  return Math.max(previous + interval, now);
}

/**
 * A transform sample: position in inches, yaw in radians, plus the derived
 * animation state the body pipeline needs. Flat arrays keep packets small;
 * the body layer rehydrates vectors.
 */
export function makePose({ position, yaw = 0, speed = 0, scoped = false, dead = false, crouch = false, tick = 0 } = {}) {
  return {
    type: MESSAGE.POSE,
    p: [round1(position?.[0] ?? 0), round1(position?.[1] ?? 0), round1(position?.[2] ?? 0)],
    yaw: round2(Number(yaw) || 0),
    speed: Math.max(0, Math.round(Number(speed) || 0)),
    scoped: Boolean(scoped),
    crouch: Boolean(crouch),
    dead: Boolean(dead),
    tick: Math.max(0, Math.trunc(Number(tick) || 0)),
  };
}

/** Reads a pose message into a plain object, tolerating missing fields. */
export function readPose(message) {
  if (!message || typeof message !== 'object') return null;
  const p = message.p;
  if (!Array.isArray(p) || p.length !== 3 || !p.every((v) => Number.isFinite(Number(v)))) return null;
  return {
    position: [Number(p[0]), Number(p[1]), Number(p[2])],
    yaw: Number(message.yaw) || 0,
    speed: Math.max(0, Number(message.speed) || 0),
    scoped: Boolean(message.scoped),
    crouch: Boolean(message.crouch),
    dead: Boolean(message.dead),
    tick: Math.max(0, Math.trunc(Number(message.tick) || 0)),
  };
}

function round1(value) { return Math.round(Number(value) * 10) / 10; }
function round2(value) { return Math.round(Number(value) * 100) / 100; }

/**
 * A shot claim: "I fired from here along this ray at host tick T". The host
 * rewinds hitboxes to T (lag compensation, phase 4) and re-raycasts.
 */
export function makeShot({ origin, direction, weapon = 'rifle', tick = 0, seq = 0 } = {}) {
  // Normalize here so callers can pass any non-zero vector (a camera ray
  // scaled by reach, for instance) and the wire format stays unit-ish.
  const dx = Number(direction?.[0]) || 0;
  const dy = Number(direction?.[1]) || 0;
  const dz = Number(direction?.[2]) || 0;
  const length = Math.hypot(dx, dy, dz) || 1;
  return {
    type: MESSAGE.SHOT,
    o: [round1(origin?.[0] ?? 0), round1(origin?.[1] ?? 0), round1(origin?.[2] ?? 0)],
    d: [round2(dx / length), round2(dy / length), round2(dz / length)],
    w: String(weapon ?? 'rifle'),
    tick: Math.max(0, Math.trunc(Number(tick) || 0)),
    seq: Math.max(0, Math.trunc(Number(seq) || 0)),
  };
}

export function readShot(message) {
  if (!message || typeof message !== 'object') return null;
  const o = message.o;
  const d = message.d;
  if (!Array.isArray(o) || o.length !== 3 || !o.every((v) => Number.isFinite(Number(v)))) return null;
  if (!Array.isArray(d) || d.length !== 3 || !d.every((v) => Number.isFinite(Number(v)))) return null;
  const length = Math.hypot(d[0], d[1], d[2]);
  if (length < 0.5 || length > 1.5) return null; // a direction, roughly unit.
  return {
    origin: [Number(o[0]), Number(o[1]), Number(o[2])],
    direction: [Number(d[0]) / length, Number(d[1]) / length, Number(d[2]) / length],
    weapon: String(message.w ?? 'rifle'),
    tick: Math.max(0, Math.trunc(Number(message.tick) || 0)),
    seq: Math.max(0, Math.trunc(Number(message.seq) || 0)),
  };
}

/** The HELLO a guest sends on joining; names are sanitized here. */
export function makeHello({ name, identity = null } = {}) {
  return {
    type: MESSAGE.HELLO,
    v: PROTOCOL_VERSION,
    name: sanitizeName(name),
    identity: identity ? String(identity) : null,
  };
}

/** The WELCOME the host answers with: everything a guest needs to render. */
export function makeWelcome({ yourId, roomCode, roster, matchState, hostTick, now }) {
  return {
    type: MESSAGE.WELCOME,
    v: PROTOCOL_VERSION,
    yourId,
    roomCode,
    hostId: HOST_ID,
    roster: roster.map(sanitizePlayer),
    match: matchState ?? null,
    tick: Math.max(0, Math.trunc(Number(hostTick) || 0)),
    now: Math.max(0, Math.trunc(Number(now) || 0)),
  };
}

/** Roster entry, shared by WELCOME and JOIN. */
export function sanitizePlayer({ id, name, team = 'ffa', human = true, local = false } = {}) {
  return {
    id: String(id ?? ''),
    name: sanitizeName(name),
    team: team === 'allies' || team === 'axis' ? team : 'ffa',
    human: Boolean(human),
    local: Boolean(local),
  };
}

/**
 * Basic structural validation for any incoming packet. Returns the message
 * when it is one of ours (has a known type and an id), else null. Does not
 * deep-validate per-type payloads -- the readers above do that.
 */
export function isValidMessage(message) {
  return Boolean(
    message && typeof message === 'object'
    && typeof message.type === 'string'
    && KNOWN_TYPES.has(message.type)
    && typeof message.id === 'string',
  );
}

/** Should this malformed packet be worth a console warning? */
export function isNoisyType(type) {
  return NOISY_TYPES.has(type);
}

export default {
  PROTOCOL_VERSION, POSE_HZ, SNAPSHOT_HZ, INTERP_DELAY_MS, HOST_TICK_HZ,
  HOST_TICK_INTERVAL_MS, POSE_INTERVAL_MS, SNAPSHOT_INTERVAL_MS,
  MAX_PLAYERS, PING_INTERVAL_MS, ROOM_CODE_LENGTH, MESSAGE, HOST_ID,
  makeRoomCode, isRoomCode, makePlayerId, sanitizeName, sanitizePlayer,
  makePose, readPose, makeShot, readShot, makeHello, makeWelcome,
  isValidMessage, isNoisyType, advanceSlot,
};
