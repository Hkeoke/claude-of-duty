// The guest-side client: the lifecycle every networked player runs.
//
// On start it sends HELLO and waits for WELCOME (or ROOM_FULL). Once in, it
// publishes its pose at 20 Hz, pings the host for RTT, and receives:
// - poses of everyone else (fed to the remote body pipeline, phase 3),
// - damage/death/respawn messages (the host owns the guest's health),
// - match snapshots (standings, phase, feed) to mirror the host's HUD.
//
// The client stays transport-agnostic: it exposes `send` and `handleMessage`,
// so the page wires the transport callbacks and node tests drive it directly
// with plain objects.

import {
  HOST_ID, MESSAGE, PING_INTERVAL_MS, POSE_INTERVAL_MS,
  advanceSlot, makeHello, makePose, makeShot,
} from './protocol.js';

const PING_SAMPLES = 5;

export class NetClient {
  constructor({ name = 'PLAYER', identity = null, now = () => performance.now() } = {}) {
    this.name = String(name ?? 'PLAYER');
    this.identity = identity ?? null;
    this.now = now;

    this.status = 'idle'; // idle | connecting | connected | closed | full
    this.roomCode = null;
    this.selfId = null;
    this.hostId = HOST_ID;
    this.pingMs = null;
    this.full = false;

    this.transport = null;
    this.players = new Map(); // id -> roster entry from the host.
    this.match = null; // last match snapshot.
    this.lastDamage = null; // { amount, health, from, seq, at }
    this.lastRespawn = null; // { seq, position, yaw, at }
    this.deaths = []; // { victim, killer, at } feed from the host.

    this.pendingPings = new Map(); // seq -> local send time.
    this.pingSeq = 0;
    this.shotSeq = 0;
    this.pingSamples = [];
    this.nextPoseAt = 0;
    this.nextPingAt = 0;
    this.poseTick = 0;
    this.lastPose = null;

    this.onMessage = null; // (message) => void, for messages the client doesn't own.
    this.onStatus = null; // (status) => void.
  }

  /** Starts the join flow over a ready transport; WELCOME arrives via handleMessage. */
  join(transport, { roomCode = null } = {}) {
    if (!transport || typeof transport.send !== 'function') throw new Error('NetClient.join requires a transport');
    this.transport = transport;
    this.roomCode = roomCode;
    this.setStatus('connecting');
    this.send(makeHello({ name: this.name, identity: this.identity }));
    return this;
  }

  /**
   * The page's transport onMessage handler forwards every packet here first.
   * Returns true when the client consumed it, false to let the page dispatch.
   */
  handleMessage(message) {
    if (!message || typeof message !== 'object') return false;
    switch (message.type) {
      case MESSAGE.WELCOME: return this.handleWelcome(message);
      case MESSAGE.ROOM_FULL: return this.handleRoomFull(message);
      case MESSAGE.PONG: return this.handlePong(message);
      case MESSAGE.DAMAGE: return this.handleDamage(message);
      case MESSAGE.RESPAWN: return this.handleRespawn(message);
      case MESSAGE.DEATH: return this.handleDeathMessage(message);
      case MESSAGE.JOIN: return this.handleJoin(message);
      case MESSAGE.LEAVE: return this.handleLeave(message);
      case MESSAGE.STATE: return this.handleState(message);
      default: return false;
    }
  }

  handleWelcome(message) {
    this.selfId = String(message.yourId ?? '');
    this.roomCode = message.roomCode ?? this.roomCode;
    this.hostId = String(message.hostId ?? HOST_ID);
    this.players = new Map((message.roster ?? []).map((player) => [player.id, player]));
    this.match = message.match ?? null;
    this.poseTick = 0;
    this.pingSamples = [];
    this.pingMs = null;
    this.setStatus('connected');
    return true;
  }

  handleRoomFull() {
    this.full = true;
    this.setStatus('full');
    return true;
  }

  handleJoin(message) {
    const player = message.player;
    if (!player?.id) return false;
    this.players.set(player.id, player);
    return true;
  }

  handleLeave(message) {
    const id = message.player?.id ?? message.player;
    if (!id) return false;
    this.players.delete(String(id));
    return true;
  }

  handleState(message) {
    if (message.match) this.match = message.match;
    // Snapshot player entries only carry { id, dead, health }: merge them
    // into the roster rather than replacing it.
    if (Array.isArray(message.players)) {
      for (const player of message.players) {
        const entry = this.players.get(player.id);
        if (entry) {
          entry.dead = Boolean(player.dead);
          entry.health = Number.isFinite(Number(player.health)) ? Number(player.health) : entry.health ?? null;
        }
      }
    }
    return true;
  }

  handleDamage(message) {
    this.lastDamage = {
      amount: Number(message.amount) || 0,
      health: Number.isFinite(Number(message.health)) ? Number(message.health) : null,
      from: message.from ?? null,
      seq: Number(message.seq) || 0,
      at: this.now(),
    };
    return true;
  }

  handleRespawn(message) {
    this.lastRespawn = {
      seq: Number(message.seq) || 0,
      position: Array.isArray(message.position) ? message.position.map(Number) : [0, 0, 0],
      yaw: Number(message.yaw) || 0,
      at: this.now(),
    };
    return true;
  }

  handleDeathMessage(message) {
    if (!message.victim) return false;
    this.deaths.unshift({ victim: String(message.victim), killer: message.killer ?? null, at: this.now() });
    if (this.deaths.length > 10) this.deaths.length = 10;
    return true;
  }

  handlePong(message) {
    const seq = Number(message.seq);
    const sentAt = this.pendingPings.get(seq);
    if (sentAt === undefined) return false;
    this.pendingPings.delete(seq);
    const rtt = Math.max(0, this.now() - sentAt);
    this.pingSamples.push(rtt);
    if (this.pingSamples.length > PING_SAMPLES) this.pingSamples.shift();
    this.pingMs = Math.round(this.pingSamples.reduce((sum, value) => sum + value, 0) / this.pingSamples.length);
    return true;
  }

  /**
   * Called every frame with the local fighter's transform. Sends the pose at
   * 20 Hz (overwrite-ok) and pings the host on the ping cadence.
   */
  update({ position, yaw = 0, speed = 0, scoped = false, crouch = false, dead = false, now = this.now() } = {}) {
    if (this.status !== 'connected') return;
    if (now >= this.nextPoseAt) {
      this.nextPoseAt = advanceSlot(this.nextPoseAt, now, POSE_INTERVAL_MS);
      this.poseTick += 1;
      this.lastPose = makePose({ position, yaw, speed, scoped, crouch, dead, tick: this.poseTick });
      this.send(this.lastPose);
    }
    if (now >= this.nextPingAt) {
      this.nextPingAt = advanceSlot(this.nextPingAt, now, PING_INTERVAL_MS);
      this.pingSeq += 1;
      this.pendingPings.set(this.pingSeq, now);
      if (this.pendingPings.size > 8) {
        const oldest = this.pendingPings.keys().next().value;
        this.pendingPings.delete(oldest);
      }
      this.send({ type: MESSAGE.PING, id: this.selfId, seq: this.pingSeq });
    }
  }

  /** Claims a shot for lag-compensated validation on the host (phase 4). */
  claimShot({ origin, direction, weapon = 'rifle', tick = 0 } = {}) {
    if (this.status !== 'connected') return false;
    return this.send(makeShot({ origin, direction, weapon, tick, seq: ++this.shotSeq }));
  }

  /** Relays a grenade throw so the host (and room) can stage the visuals. */
  throwGrenade({ origin, velocity, kind = 'frag' } = {}) {
    if (this.status !== 'connected') return false;
    return this.send({
      type: MESSAGE.GRENADE, id: this.selfId,
      o: origin.map(Number), v: velocity.map(Number), k: String(kind),
    });
  }

  send(message, options = null) {
    try {
      this.transport?.send(message, options ?? undefined);
      return true;
    } catch {
      return false;
    }
  }

  leave() {
    if (this.transport) {
      this.send({ type: MESSAGE.LEAVE, id: this.selfId, player: this.selfId });
    }
    this.transport = null;
    this.setStatus('closed');
  }

  setStatus(value) {
    if (this.status === value) return;
    this.status = value;
    this.onStatus?.(value);
  }

  /** Serializable observation for the debug API (`net` block). */
  getState() {
    return {
      status: this.status,
      roomCode: this.roomCode,
      selfId: this.selfId,
      hostId: this.hostId,
      pingMs: this.pingMs,
      full: this.full,
      playerCount: this.players.size,
      poseTick: this.poseTick,
      lastPose: this.lastPose
        ? { p: this.lastPose.p, yaw: this.lastPose.yaw, tick: this.lastPose.tick }
        : null,
      lastDamage: this.lastDamage,
      match: this.match ? { phase: this.match.phase, standings: this.match.standings?.length ?? 0 } : null,
    };
  }
}

export default NetClient;
