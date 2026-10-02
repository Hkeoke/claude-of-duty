// The combatant registry: one place that answers "who is alive and where".
//
// The shooter used to hard-code its target lists as `[player, ...enemies]`:
// grenade blasts, melee picks, flinch direction, spawn safety, bot-vs-bot
// combat and the killfeed all re-derived that pair in their own way. This
// module names those facts once so a remote human player is just another
// entry, and every consumer reads the same list.
//
// It holds identity and observation only -- ids, names, team, positions,
// health, liveness -- and never Three.js objects. The registry is an index
// of entries built elsewhere; an `enemy` (Enemy) or the live player object
// stays attachable through `source` for the consumers that need a mesh or a
// controller. Damage is dispatched through `applyDamage` so a bot body and a
// remote player's networked health can behave differently behind one call.

import * as THREE from 'three';

export const TEAMS = Object.freeze({ ffa: 'ffa', allies: 'allies', axis: 'axis' });

const UP = new THREE.Vector3(0, 1, 0);
const _position = new THREE.Vector3();

/**
 * Wraps one fighter -- the local player, a bot, or later a remote human --
 * in the shape every combatant consumer reads. `source` is the object the
 * rest of the game already knows how to talk to: a PlayerController for the
 * local player, an Enemy for a bot, and `null` when the entry is driven
 * directly (a remote player pose applied by the net layer).
 *
 * Positions are read fresh from the source on every query, so there is no
 * copy of the world to go stale. `healthOf`/`deadOf` and `applyDamage` default
 * to the source's takeDamage-style API and can be overridden per entry.
 */
export class Combatant {
  constructor({
    id,
    name = id,
    team = TEAMS.ffa,
    source = null,
    human = false,
    local = false,
    positionOf = null,
    feetOf = null,
    velocityOf = null,
    speedOf = null,
    healthOf = null,
    deadOf = null,
    applyDamage = null,
  } = {}) {
    if (!id) throw new Error('Combatant requires an id');
    this.id = String(id);
    this.name = String(name ?? this.id);
    this.team = team;
    this.source = source ?? null;
    this.human = Boolean(human);
    this.local = Boolean(local);
    this.positionOf = positionOf;
    this.feetOf = feetOf;
    this.velocityOf = velocityOf;
    this.speedOf = speedOf;
    this.healthOf = healthOf;
    this.deadOf = deadOf;
    this.applyDamage = applyDamage;
    // Written by whoever simulates this fighter (the local player, the bot
    // AI, the net layer). The scoreboard aggregates from the match, not here.
    this.kills = 0;
    this.deaths = 0;
    this.deadOverride = undefined;
  }

  /** Torso centre, the aim point every targeting path already uses. */
  position(result = new THREE.Vector3()) {
    if (this.positionOf) return this.positionOf(result);
    if (this.source?.root) return result.copy(this.source.root.position).addScaledVector(UP, 42);
    if (this.source?.position) return result.copy(this.source.position);
    return result.set(0, 0, 0);
  }

  /**
   * Torso centre when the entry is its own source (a remote player driven
   * directly by the net layer), used by callers that pass the entry around
   * as the target object. Matches EnemyManager.targetPosition()'s shape.
   */
  get root() {
    const self = this;
    return {
      get position() {
        return self.position(new THREE.Vector3());
      },
    }; 
  }

  /** Feet position: spawning, blast occlusion probes, ground checks. */
  feet(result = new THREE.Vector3()) {
    if (this.feetOf) return this.feetOf(result);
    if (this.source?.feetPosition) return result.copy(this.source.feetPosition);
    if (this.source?.root) return result.copy(this.source.root.position);
    return result.set(0, 0, 0);
  }

  /** EnemyManager.targetFeet() shape for entries used as target sources. */
  get feetPosition() {
    return this.feet(new THREE.Vector3());
  }

  /** Networked liveness for entries driven directly by the net layer. */
  setDead(value) {
    this.deadOverride = Boolean(value);
  }

  /** Horizontal speed, in inches per second: 0 when unknown. */
  horizontalSpeed() {
    if (this.speedOf) return Math.max(0, Number(this.speedOf()) || 0);
    if (this.velocityOf) {
      const velocity = this.velocityOf();
      return Math.hypot(velocity?.x ?? 0, velocity?.z ?? 0);
    }
    const velocity = this.source?.velocity;
    return velocity ? Math.hypot(velocity.x, velocity.z) : 0;
  }

  health() {
    if (this.healthOf) return this.healthOf();
    if (typeof this.source?.health === 'number') return this.source.health;
    if (typeof this.source?.health === 'function') return this.source.health();
    return null;
  }

  dead() {
    if (this.deadOf) return Boolean(this.deadOf());
    if (this.deadOverride !== undefined) return this.deadOverride;
    return Boolean(this.source?.dead);
  }

  /**
   * Applies damage from `attacker` (a Combatant or null for the world).
   * Returns the damage actually applied, 0 when the fighter is dead or
   * protected, or null when this entry has no damage path (a spectator).
   */
  damage(amount, attacker = null, hit = null) {
    if (this.applyDamage) return this.applyDamage(amount, attacker?.source ?? null, hit);
    if (typeof this.source?.takeDamage !== 'function') return null;
    return this.source.takeDamage(amount, hit, attacker?.source ?? null);
  }

  /**
   * Enemy-style damage entry so bot code can call `target.takeDamage(amount,
   * hit, source)` against any combatant shape without branching.
   */
  takeDamage(amount, hit = null, source = null) {
    return this.damage(amount, source, hit);
  }

  /** Serializable observation for HUD and debug surfaces. */
  getState() {
    return {
      id: this.id,
      name: this.name,
      team: this.team,
      human: this.human,
      local: this.local,
      dead: this.dead(),
      health: this.health(),
      position: this.position(_position).toArray().map((value) => Math.round(value * 10) / 10),
      speed: Math.round(this.horizontalSpeed()),
    };
  }
}

/**
 * The registry. Owns the id -> combatant map and the query methods the
 * shooter's consumers call. `_vec` scratch results are shared between calls
 * on purpose: every method hands out a fresh Vector3 when the caller asks for
 * one and writes into scratch only for internal comparisons.
 */
export class CombatantRegistry {
  constructor() {
    this.entries = new Map();
  }

  add(combatant) {
    if (!(combatant instanceof Combatant)) throw new Error('registry entries are Combatants');
    if (this.entries.has(combatant.id)) throw new Error(`duplicate combatant id ${combatant.id}`);
    this.entries.set(combatant.id, combatant);
    return combatant;
  }

  get(id) {
    return this.entries.get(String(id)) ?? null;
  }

  /** The combatant wrapping `source`, or null. O(n); call sites cache nothing. */
  bySource(source) {
    if (!source) return null;
    // An entry used as its own source (a remote player passed around directly).
    if (source instanceof Combatant && this.entries.get(source.id) === source) return source;
    for (const entry of this.entries.values()) {
      if (entry.source === source) return entry;
    }
    return null;
  }

  has(id) {
    return this.entries.has(String(id));
  }

  delete(id) {
    return this.entries.delete(String(id));
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }

  /** Every combatant, in insertion order. */
  all() {
    return [...this.entries.values()];
  }

  /** Every combatant that is not dead right now. */
  alive() {
    return this.all().filter((entry) => !entry.dead());
  }

  /** All living combatants except `except` (a Combatant, not an id). */
  others(except) {
    return this.alive().filter((entry) => entry !== except);
  }

  /**
   * Nearest living combatant to `position`, excluding `except`, whose centre
   * is within `maxDistance` and, when `lineClear(from, to)` is supplied, has
   * an unobstructed line to that centre. Returns the Combatant or null.
   */
  nearestTo(position, { except = null, maxDistance = Infinity, lineClear = null, from = null } = {}) {
    let best = null;
    let bestDistance = maxDistance;
    for (const entry of this.alive()) {
      if (entry === except) continue;
      const candidate = entry.position(_vec);
      const distance = position.distanceTo(candidate);
      if (distance >= bestDistance) continue;
      if (lineClear && from && !lineClear(from, candidate)) continue;
      best = entry;
      bestDistance = distance;
    }
    return best;
  }

  /** True when nobody but `except` is alive: the win-by-attrition cases. */
  onlyLeft(except) {
    return this.alive().every((entry) => entry === except);
  }

  /**
   * Serializable list for debug and network snapshots. Ordering is stable
   * (insertion order), which keeps snapshots diffable frame to frame.
   */
  getState() {
    return this.all().map((entry) => entry.getState());
  }
}

/**
 * Standard adapters. `LocalPlayerCombatant` reads the PlayerController and
 * PlayerHealth exactly as the page reads them today; `BotCombatant` reads an
 * Enemy. Both stay thin so a change to those classes is one edit here.
 */
export function localPlayerCombatant({ id = 'player', name = 'YOU', source, playerHealth }) {
  return new Combatant({
    id, name, human: true, local: true, source,
    positionOf: (result) => result.copy(source.position),
    feetOf: (result) => result.copy(source.feetPosition),
    velocityOf: () => source.velocity,
    healthOf: () => playerHealth?.health ?? null,
    deadOf: () => playerHealth?.dead ?? false,
    applyDamage: (amount, attacker, hit) => playerHealth?.takeDamage(amount, attacker ?? hit ?? null) ?? 0,
  });
}

export function botCombatant(enemy) {
  return new Combatant({
    id: `bot-${enemy.index}`,
    source: enemy,
    positionOf: (result) => result.copy(enemy.root.position).addScaledVector(UP, 42),
    feetOf: (result) => result.copy(enemy.root.position),
    // The Enemy tracks only a scalar pace, not a velocity vector.
    speedOf: () => enemy.movementSpeed,
  });
}

const _vec = new THREE.Vector3();

export default CombatantRegistry;
