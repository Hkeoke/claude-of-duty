import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import {
  Combatant, CombatantRegistry, TEAMS, botCombatant, localPlayerCombatant,
} from '../export/web/combatants.js';

test('a bot combatant reads positions, pace and liveness from its Enemy', () => {
  const enemy = {
    index: 2,
    dead: false,
    health: 60,
    movementSpeed: 210,
    root: { position: new THREE.Vector3(10, 0, 20) },
  };
  const entry = botCombatant(enemy);

  assert.equal(entry.id, 'bot-2');
  assert.equal(entry.team, TEAMS.ffa);
  assert.equal(entry.human, false);
  assert.equal(entry.local, false);
  assert.equal(entry.dead(), false);
  assert.equal(entry.health(), 60);
  assert.equal(entry.horizontalSpeed(), 210);
  // Position is the torso centre the AI already aims at.
  assert.deepEqual(entry.position().toArray(), [10, 42, 20]);
  assert.deepEqual(entry.feet().toArray(), [10, 0, 20]);
  // Death on the source is observed, not copied.
  enemy.dead = true;
  assert.equal(entry.dead(), true);
});

test('the local player combatant delegates health, death and damage to PlayerHealth', () => {
  const taken = [];
  const player = {
    position: new THREE.Vector3(1, 60, 2),
    feetPosition: new THREE.Vector3(1, 0, 2),
    velocity: { x: 300, y: 0, z: 0 },
  };
  const playerHealth = {
    health: 85,
    dead: false,
    takeDamage(amount, source) { taken.push([amount, source]); return amount; },
  };
  const entry = localPlayerCombatant({ source: player, playerHealth });

  assert.equal(entry.id, 'player');
  assert.equal(entry.human, true);
  assert.equal(entry.local, true);
  assert.equal(entry.dead(), false);
  assert.equal(entry.health(), 85);
  assert.equal(entry.horizontalSpeed(), 300);
  assert.deepEqual(entry.position().toArray(), [1, 60, 2]);

  entry.damage(30, { source: 'shooter' });
  assert.deepEqual(taken, [[30, 'shooter']]);
});

test('an Enemy-shaped source can takeDamage a remote combatant entry directly', () => {
  const entry = new Combatant({ id: 'p2', name: 'GUEST', applyDamage: (amount, attacker) => amount + (attacker ? 1 : 0) });
  // EnemyManager.enemyFire() calls hitActor.takeDamage(damage, null, enemy):
  // source third, hit second. `enemy` here is a bare object, so attacker stays
  // unwrapped (the manager resolves known ids itself before this point).
  assert.equal(entry.takeDamage(12, null, { index: 1 }), 12);
  assert.equal(entry.takeDamage(12, null, null), 12);
});

test('a driven combatant (no source) answers position, feet and death from overrides', () => {
  const entry = new Combatant({
    id: 'p2',
    name: 'GUEST',
    positionOf: (result) => result.set(5, 42, 6),
    feetOf: (result) => result.set(5, 0, 6),
    speedOf: () => 180,
  });
  assert.deepEqual(entry.position().toArray(), [5, 42, 6]);
  assert.deepEqual(entry.feet().toArray(), [5, 0, 6]);
  assert.equal(entry.horizontalSpeed(), 180);
  assert.equal(entry.dead(), false);
  assert.equal(entry.health(), null);

  entry.setDead(true);
  assert.equal(entry.dead(), true);
  // The override only changes observation; the entry still has no damage path.
  assert.equal(entry.damage(10), null);
});

test('the registry answers alive, others, nearest and onlyLeft queries', () => {
  const registry = new CombatantRegistry();
  const make = (id, x, dead = false) => {
    const entry = new Combatant({ id, positionOf: (result) => result.set(x, 42, 0) });
    entry.deadOverride = dead;
    return entry;
  };
  const a = make('a', 0);
  const b = make('b', 100);
  const c = make('c', 900, true);
  for (const entry of [a, b, c]) registry.add(entry);

  assert.equal(registry.size, 3);
  assert.equal(registry.get('b'), b);
  assert.equal(registry.get('nope'), null);
  assert.deepEqual(registry.alive(), [a, b]);
  assert.deepEqual(registry.others(a), [b]);
  assert.equal(registry.nearestTo(new THREE.Vector3(60, 42, 0)), b);
  assert.equal(registry.nearestTo(new THREE.Vector3(60, 42, 0), { except: b, maxDistance: 200 }), a);
  assert.equal(registry.onlyLeft(a), false);
  assert.equal(registry.onlyLeft(a, { ignore: [] }), false);
  assert.equal(registry.onlyLeft(a), false);
  // Only a alive among {a, b(dead), c(dead)} is left.
  b.deadOverride = true;
  assert.equal(registry.onlyLeft(a), true);
  assert.deepEqual(registry.getState().map((state) => state.id), ['a', 'b', 'c']);
});

test('the registry resolves entries used as target sources', () => {
  const registry = new CombatantRegistry();
  const entry = new Combatant({ id: 'p2', positionOf: (result) => result.set(1, 2, 3) });
  registry.add(entry);

  assert.equal(registry.bySource(entry), entry);
  assert.equal(registry.bySource({}), null);
  assert.equal(registry.bySource(null), null);
  assert.equal(registry.get(entry.id), entry);
});

test('duplicate ids and non-combatant entries are rejected', () => {
  const registry = new CombatantRegistry();
  registry.add(new Combatant({ id: 'x' }));
  assert.throws(() => registry.add(new Combatant({ id: 'x' })), /duplicate/);
  assert.throws(() => registry.add({ id: 'y' }), /Combatants/);
});

test('getState stays serializable and rounded for HUD and debug surfaces', () => {
  const entry = new Combatant({
    id: 'p2',
    name: 'GUEST',
    team: TEAMS.allies,
    human: true,
    positionOf: (result) => result.set(10.45, 42.5, -3.25),
    speedOf: () => 222.6,
  });
  const state = entry.getState();
  assert.deepEqual(state, {
    id: 'p2',
    name: 'GUEST',
    team: 'allies',
    human: true,
    local: false,
    dead: false,
    health: null,
    position: [10.5, 42.5, -3.2],
    speed: 223,
  });
  assert.equal(JSON.parse(JSON.stringify(state)).id, 'p2');
});
