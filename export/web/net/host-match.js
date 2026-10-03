// The host-side match: the authority for membership, guest health, and the
// packet cadence. The host page keeps simulating the game exactly as it does
// solo -- bots, grenades, the local player -- and HostMatch layers three jobs
// on top:
//
// 1. Membership: HELLO -> WELCOME (or ROOM_FULL), JOIN/LEAVE to everyone,
//    with a human cap (bots never consume seats).
// 2. Guest state: the host owns each guest's health and respawns. Damage
//    reported by the host's hitscan is applied here and sent to the victim
//    as a reliable `damage` message; deaths broadcast to the room.
// 3. Cadence: pose rebroadcasts at 20 Hz, pings answered, match snapshots
//    when something changed, bots topped up to keep the roster lively.
//
// Routing: peers have a stable `identity` (the transport-level name); the
// host mints each guest a separate player id on join. Unicast replies go
// `to` the identity, broadcasts carry the sender's player id in `id`. The
// host's own fights play under `hostPlayerId` (the page passes 'player' so
// the existing scoreboard plumbing keeps working).
//
// The class is transport-agnostic: it emits outgoing messages through
// `emit(message, to)` and consumes inbound messages handed to
// `handleMessage(message, fromIdentity)`, so node tests drive it with a bus.

import {
  HOST_ID, MAX_PLAYERS, MESSAGE, POSE_INTERVAL_MS, SNAPSHOT_INTERVAL_MS,
  advanceSlot, makePlayerId, makeWelcome, readPose, readShot, sanitizePlayer,
  sanitizeName,
} from './protocol.js';

const FILL_TARGET = 8; // total fighters (humans + bots) the host aims for.
const GUEST_TIMEOUT_MS = 12000;

export class HostMatch {
  constructor({
    emit,
    match,
    combatants = null,
    hostPlayerId = HOST_ID,
    fillBots = true,
    maxHumans = MAX_PLAYERS - 1,
    onGuestAdded = null,
    onGuestRemoved = null,
    onGrenade = null,
    onShot = null,
    onRoomFull = null,
    now = () => performance.now(),
  } = {}) {
    if (typeof emit !== 'function') throw new Error('HostMatch requires an emit(message, to) callback');
    if (!match) throw new Error('HostMatch requires the authoritative match');
    this.emit = emit;
    this.match = match;
    this.combatants = combatants; // CombatantRegistry when the page runs one.
    this.hostPlayerId = String(hostPlayerId);
    this.fillBots = Boolean(fillBots);
    this.maxHumans = Math.max(1, Math.trunc(maxHumans));
    this.onGuestAdded = onGuestAdded;
    this.onGuestRemoved = onGuestRemoved;
    this.onGrenade = onGrenade;
    this.onShot = onShot;
    this.onRoomFull = onRoomFull;
    this.now = now;

    this.guests = new Map(); // player id -> guest
    this.byIdIdentity = new Map(); // transport identity -> guest
    this.nextPoseAt = 0;
    this.nextSnapshotAt = 0;
    this.lastSnapshotJson = '';
    this.tick = 0;
  }

  /** All fighters the host knows: guests, then the host player. */
  roster() {
    const players = [];
    for (const guest of this.guests.values()) {
      players.push(sanitizePlayer({ id: guest.id, name: guest.name, team: 'ffa', human: true }));
    }
    players.push(sanitizePlayer({
      id: this.hostPlayerId, name: 'HOST', team: 'ffa', human: true, local: true,
    }));
    return players;
  }

  humanCount() {
    return this.guests.size + 1; // the host plays too.
  }

  // ------------------------------------------------------------------
  // Inbound: one entry point, from the transport.
  // ------------------------------------------------------------------

  handleMessage(message, fromIdentity = null) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case MESSAGE.HELLO: return this.handleHello(message, fromIdentity);
      case MESSAGE.POSE: return this.handlePose(message, fromIdentity);
      case MESSAGE.PING: return this.handlePing(message, fromIdentity);
      case MESSAGE.SHOT: return this.handleShot(message, fromIdentity);
      case MESSAGE.GRENADE: return this.handleGrenade(message, fromIdentity);
      case MESSAGE.LEAVE: return this.handleLeaveMessage(message, fromIdentity);
      default: return;
    }
  }

  handleHello(message, identity) {
    if (!identity) return;
    if (this.byIdIdentity.has(identity)) return this.rewelcome(identity);
    // maxHumans counts the host's own seat: 8 seats = host + 7 guests.
    if (this.humanCount() >= this.maxHumans) {
      this.emit({ type: MESSAGE.ROOM_FULL, id: this.hostPlayerId }, identity);
      this.onRoomFull?.(identity);
      return;
    }
    const name = sanitizeName(message.name ?? identity);
    const id = makePlayerId();
    const guest = {
      id,
      name,
      identity,
      pose: null,
      health: 100,
      dead: false,
      lastSeen: this.now(),
      damageSeq: 0,
      spawnSeq: 0,
    };
    this.guests.set(id, guest);
    this.byIdIdentity.set(identity, guest);
    this.match?.register?.(id, name, { human: true });
    const player = sanitizePlayer({ id, name, team: 'ffa', human: true });
    this.emit(makeWelcome({
      yourId: id,
      roomCode: null, // the page fills the real code in when it has one.
      roster: this.roster(),
      matchState: this.match?.getState?.() ?? null,
      hostTick: this.tick,
      now: Date.now(),
    }), identity);
    this.emit({ type: MESSAGE.JOIN, id: this.hostPlayerId, player, roster: this.roster() });
    this.onGuestAdded?.(guest);
    this.topUpBots();
  }

  /** An already-seen identity saying hello again (tab reload, reconnect). */
  rewelcome(identity) {
    const guest = this.byIdIdentity.get(identity);
    guest.lastSeen = this.now();
    this.emit(makeWelcome({
      yourId: guest.id,
      roomCode: null,
      roster: this.roster(),
      matchState: this.match?.getState?.() ?? null,
      hostTick: this.tick,
      now: Date.now(),
    }), identity);
  }

  handlePose(message, identity) {
    const guest = this.byIdIdentity.get(identity);
    if (!guest) return;
    const pose = readPose(message);
    if (!pose) return;
    guest.pose = pose;
    guest.lastSeen = this.now();
  }

  handlePing(message, identity) {
    if (!this.byIdIdentity.get(identity)) return;
    this.emit({ type: MESSAGE.PONG, id: this.hostPlayerId, seq: message.seq }, identity);
  }

  handleShot(message, identity) {
    const guest = this.byIdIdentity.get(identity);
    if (!guest) return;
    const shot = readShot(message);
    if (!shot) return;
    guest.lastSeen = this.now();
    // The page validates the claim against lag-compensated hitboxes (phase
    // 4) and reports the outcome through applyGuestDamage; here the tracer
    // and audio cue only relay onward.
    this.onShot?.(guest, shot);
  }

  handleGrenade(message, identity) {
    const guest = this.byIdIdentity.get(identity);
    if (!guest) return;
    const origin = message.o;
    const velocity = message.v;
    if (!Array.isArray(origin) || !Array.isArray(velocity)) return;
    if (![...origin, ...velocity].every((value) => Number.isFinite(Number(value)))) return;
    guest.lastSeen = this.now();
    this.onGrenade?.(guest, {
      origin: origin.map(Number), velocity: velocity.map(Number), kind: message.k === 'smoke' ? 'smoke' : 'frag',
    });
  }

  handleLeaveMessage(message, identity) {
    const guest = this.byIdIdentity.get(identity)
      ?? this.guests.get(String(message.player ?? ''));
    if (!guest) return;
    this.removeGuest(guest.id, 'leave');
  }

  // ------------------------------------------------------------------
  // Outbound cadence + guest state, driven by the host's tick.
  // ------------------------------------------------------------------

  /** Called from the page's frame loop; paces the broadcasts. */
  update(deltaSeconds, { localPose = null, now = this.now() } = {}) {
    this.tick += 1;
    for (const guest of [...this.guests.values()]) {
      if (now - guest.lastSeen > GUEST_TIMEOUT_MS) this.removeGuest(guest.id, 'timeout');
    }
    if (now >= this.nextPoseAt) {
      this.nextPoseAt = advanceSlot(this.nextPoseAt, now, POSE_INTERVAL_MS);
      this.broadcastPose(localPose);
    }
    if (now >= this.nextSnapshotAt) {
      this.nextSnapshotAt = advanceSlot(this.nextSnapshotAt, now, SNAPSHOT_INTERVAL_MS);
      this.broadcastSnapshot();
    }
  }

  broadcastPose(localPose) {
    // One message per fighter, unreliable, room-wide. Guests interpose the
    // bodies themselves; nothing here is worth retransmitting.
    for (const guest of this.guests.values()) {
      if (!guest.pose) continue;
      this.emit({ type: MESSAGE.POSE, id: guest.id, ...guest.pose });
    }
    if (localPose) this.emit({ type: MESSAGE.POSE, id: this.hostPlayerId, ...localPose });
  }

  broadcastSnapshot() {
    const message = {
      type: MESSAGE.STATE,
      id: this.hostPlayerId,
      tick: this.tick,
      match: this.match?.getState?.() ?? null,
      players: this.roster().map((player) => ({
        id: player.id, dead: this.isDead(player.id), health: this.healthOf(player.id),
      })),
    };
    const json = JSON.stringify(message);
    if (json === this.lastSnapshotJson) return; // nothing changed, skip.
    this.lastSnapshotJson = json;
    this.emit(message);
  }

  isDead(id) {
    if (id === this.hostPlayerId) return Boolean(this.combatants?.get(id)?.dead?.());
    return this.guests.get(String(id))?.dead ?? false;
  }

  healthOf(id) {
    if (id === this.hostPlayerId) return this.combatants?.get(id)?.health?.() ?? null;
    return this.guests.get(String(id))?.health ?? null;
  }

  /** The host's hitscan (or a blast) damaged a guest. */
  applyGuestDamage(guestId, amount, { attackerId = null, hit = null } = {}) {
    const guest = this.guests.get(String(guestId));
    if (!guest || guest.dead) return 0;
    const applied = Math.max(0, Math.min(guest.health, Number(amount) || 0));
    guest.health -= applied;
    guest.damageSeq += 1;
    this.emit({
      type: MESSAGE.DAMAGE, id: this.hostPlayerId,
      amount: applied, health: guest.health, from: attackerId,
      seq: guest.damageSeq, hit: hit ? { region: hit.region ?? 'torso' } : null,
    }, guest.identity);
    if (guest.health <= 0) {
      guest.dead = true;
      this.match?.recordKill?.(attackerId ?? null, guest.id);
      this.emit({ type: MESSAGE.DEATH, id: this.hostPlayerId, victim: guest.id, killer: attackerId ?? null });
      this.combatants?.get(guest.id)?.setDead(true);
    }
    return applied;
  }

  /** Respawns a dead guest at a safe spawn, with a rising spawn seq. */
  respawnGuest(guestId, spawn = null) {
    const guest = this.guests.get(String(guestId));
    if (!guest) return null;
    guest.health = 100;
    guest.dead = false;
    guest.spawnSeq += 1;
    guest.pose = null; // the guest's next pose repaints from its new origin.
    this.combatants?.get(guest.id)?.setDead(false);
    const message = {
      type: MESSAGE.RESPAWN, id: this.hostPlayerId, seq: guest.spawnSeq,
      position: spawn?.position ?? [0, 0, 0], yaw: spawn?.yaw ?? 0,
    };
    this.emit(message, guest.identity);
    return message;
  }

  removeGuest(guestId, reason = 'leave') {
    const guest = this.guests.get(String(guestId));
    if (!guest) return false;
    this.guests.delete(guest.id);
    this.byIdIdentity.delete(guest.identity);
    this.match?.combatants?.delete?.(guest.id); // the match scoreboard.
    this.combatants?.delete(guest.id); // the combatant registry, when wired.
    this.emit({
      type: MESSAGE.LEAVE, id: this.hostPlayerId,
      player: sanitizePlayer({ id: guest.id, name: guest.name }), reason,
    });
    this.onGuestRemoved?.(guest, reason);
    this.topUpBots();
    return true;
  }

  /**
   * Bots the page should host so the room stays lively (humans never take
   * bot seats). The EnemyManager grows and shrinks to this number.
   */
  botTarget() {
    return this.fillBots ? Math.max(0, FILL_TARGET - this.humanCount()) : 0;
  }

  topUpBots() {
    return this.botTarget();
  }

  getState() {
    return {
      host: this.hostPlayerId,
      humans: this.humanCount(),
      maxHumans: this.maxHumans,
      guests: [...this.guests.values()].map((guest) => ({
        id: guest.id, name: guest.name, dead: guest.dead, health: guest.health,
        poseTick: guest.pose?.tick ?? null, identity: guest.identity,
      })),
      botTarget: this.botTarget(),
      tick: this.tick,
    };
  }
}

export default HostMatch;
