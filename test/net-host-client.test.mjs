import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MESSAGE } from '../export/web/net/protocol.js';
import { HostMatch } from '../export/web/net/host-match.js';
import { NetClient } from '../export/web/net/net-client.js';

/**
 * In-memory bus mirroring the BroadcastChannel/LiveKit topology: guest sends
 * always carry the guest's identity; host sends either name one identity
 * (`to`) or broadcast to the room. Guest->host is synchronous; host->guest
 * queues in the outbox until `drainHostOutbox()`.
 */
function makeBus() {
  const host = { handler: null, outbox: [] };
  const guests = [];
  let nextIdentity = 0;
  const bus = {
    host,
    guests,
    attachHost(handler) { host.handler = handler; },
    addGuest(name) {
      nextIdentity += 1;
      const identity = `guest-${nextIdentity}`;
      const guest = {
        name,
        identity,
        id: null, // the player id, learned from the host's WELCOME.
        inbox: [],
        handler: null,
        transport: {
          kind: 'stub',
          send(message) {
            bus.host.handler?.(message, identity);
          },
          close() {},
        },
      };
      guests.push(guest);
      return guest;
    },
    deliverToGuest(identity, message, to) {
      const guest = guests.find((candidate) => candidate.identity === identity);
      if (!guest) return;
      if (to && to !== identity) return;
      // Learn our assigned id from the WELCOME, like the real page does when
      // NetClient.handleWelcome stores selfId.
      if (message.type === MESSAGE.WELCOME && !guest.id) guest.id = message.yourId;
      guest.inbox.push(message);
      guest.handler?.(message);
    },
    drainHostOutbox() {
      const sent = host.outbox.splice(0);
      for (const { message, to } of sent) {
        if (to) {
          bus.deliverToGuest(to, message, to);
          continue;
        }
        for (const guest of guests) {
          guest.inbox.push(message);
          guest.handler?.(message);
        }
      }
      return sent;
    },
    countTypes(drained, type) {
      return drained.filter(({ message }) => message.type === type).length;
    },
  };
  return bus;
}

function makeHost(bus, { match, combatants = null, now, ...rest } = {}) {
  const hostMatch = new HostMatch({
    emit: (message, to) => { bus.host.outbox.push({ message, to }); },
    match,
    combatants,
    now,
    ...rest,
  });
  bus.attachHost((message, identity) => hostMatch.handleMessage(message, identity));
  return hostMatch;
}

function makeGuestClient(bus, name, now) {
  const guest = bus.addGuest(name);
  const client = new NetClient({ name, now });
  guest.handler = (message) => { client.handleMessage(message); };
  client.join(guest.transport, {});
  return { guest, client };
}

const stubMatch = (overrides = {}) => ({
  register: () => {},
  getState: () => ({ phase: 'playing' }),
  ...overrides,
});

test('a guest joins through HELLO/WELCOME and lands on the roster', () => {
  const bus = makeBus();
  const now = () => 1000;
  const hostMatch = makeHost(bus, { match: stubMatch(), now });
  const { guest, client } = makeGuestClient(bus, 'guest one', now);

  const drained = bus.drainHostOutbox();
  assert.equal(drained.length, 2); // WELCOME (unicast) + JOIN (broadcast).
  assert.equal(client.status, 'connected');
  assert.match(client.selfId, /^p[a-z0-9]{5}$/);
  assert.equal(guest.id, client.selfId);
  assert.equal(hostMatch.humanCount(), 2);
  assert.equal(client.players.size, 2);
  assert.equal(hostMatch.byIdIdentity.get(guest.identity).id, client.selfId);
});

test('poses flow guest to host immediately and fan out on the cadence', () => {
  const bus = makeBus();
  let clock = 1000;
  const now = () => clock;
  const hostMatch = makeHost(bus, { match: stubMatch(), now });
  const { client } = makeGuestClient(bus, 'GUEST', now);
  bus.drainHostOutbox();

  // The guest's first pose lands on the host at once.
  client.update({ position: [10, 60, 20], yaw: 0.5, speed: 200, now: clock });
  const guest = bus.guests[0];
  assert.deepEqual(hostMatch.byIdIdentity.get(guest.identity).pose.position, [10, 60, 20]);

  // First host update: pose broadcast (guest + host) plus the first snapshot.
  clock += 50;
  hostMatch.update(0.05, { localPose: { position: [0, 60, 0], yaw: 0, tick: 1 }, now: clock });
  let drained = bus.drainHostOutbox();
  assert.equal(bus.countTypes(drained, MESSAGE.POSE), 2);
  assert.equal(bus.countTypes(drained, MESSAGE.STATE), 1);

  // Before the next pose cadence elapses, only non-pose messages flow.
  clock += 40;
  hostMatch.update(0.04, { localPose: { position: [0, 60, 0], yaw: 0, tick: 1 }, now: clock });
  drained = bus.drainHostOutbox();
  assert.equal(bus.countTypes(drained, MESSAGE.POSE), 0);

  clock += 60;
  hostMatch.update(0.06, { localPose: { position: [1, 60, 0], yaw: 0, tick: 2 }, now: clock });
  drained = bus.drainHostOutbox();
  assert.equal(bus.countTypes(drained, MESSAGE.POSE), 2);
});

test('the room fills up and extra guests are refused with room-full', () => {
  const bus = makeBus();
  const now = () => 1000;
  const hostMatch = makeHost(bus, { match: stubMatch(), now, maxHumans: 3 }); // host + 2.
  const a = makeGuestClient(bus, 'A', now);
  bus.drainHostOutbox();
  const b = makeGuestClient(bus, 'B', now);
  bus.drainHostOutbox();
  assert.equal(a.client.status, 'connected');
  assert.equal(b.client.status, 'connected');

  const c = makeGuestClient(bus, 'C', now);
  bus.drainHostOutbox();
  assert.equal(c.client.status, 'full');
  assert.equal(c.client.full, true);
  assert.equal(hostMatch.guests.size, 2);
});

test('damage flows through the host: health drops, death, respawn', () => {
  const bus = makeBus();
  const now = () => 1000;
  const kills = [];
  const hostMatch = makeHost(bus, {
    match: stubMatch({ recordKill: (killerId, victimId) => kills.push([killerId, victimId]) }),
    now,
  });
  const { client } = makeGuestClient(bus, 'VICTIM', now);
  bus.drainHostOutbox();

  const applied = hostMatch.applyGuestDamage(client.selfId, 40, { attackerId: 'player' });
  assert.equal(applied, 40);
  assert.equal(hostMatch.guests.get(client.selfId).health, 60);

  bus.drainHostOutbox();
  assert.equal(client.lastDamage.amount, 40);
  assert.equal(client.lastDamage.health, 60);
  assert.equal(client.lastDamage.from, 'player');

  hostMatch.applyGuestDamage(client.selfId, 100, { attackerId: 'player' });
  assert.equal(hostMatch.guests.get(client.selfId).dead, true);
  assert.deepEqual(kills, [['player', client.selfId]]);
  // Damage to a dead guest is refused.
  assert.equal(hostMatch.applyGuestDamage(client.selfId, 10), 0);

  const respawn = hostMatch.respawnGuest(client.selfId, { position: [5, 0, 6], yaw: 1 });
  assert.equal(respawn.position.join(','), '5,0,6');
  assert.equal(hostMatch.guests.get(client.selfId).dead, false);
  assert.equal(hostMatch.guests.get(client.selfId).health, 100);
  bus.drainHostOutbox();
  assert.equal(client.lastRespawn.position.join(','), '5,0,6');
  assert.equal(client.lastRespawn.seq, 1);
});

test('shots and grenades route to the host hooks with the guest attached', () => {
  const bus = makeBus();
  const now = () => 1000;
  let shot = null;
  let grenade = null;
  const hostMatch = makeHost(bus, {
    match: stubMatch(), now,
    onShot: (guest, staged) => { shot = { guest, staged }; },
    onGrenade: (guest, staged) => { grenade = { guest, staged }; },
  });
  const { client } = makeGuestClient(bus, 'SHOOTER', now);
  bus.drainHostOutbox();

  assert.equal(client.claimShot({ origin: [1, 2, 3], direction: [0, 0, 1], weapon: 'smg', tick: 9 }), true);
  assert.equal(shot.guest.id, client.selfId);
  assert.equal(shot.staged.weapon, 'smg');
  assert.deepEqual(shot.staged.direction, [0, 0, 1]);

  assert.equal(client.throwGrenade({ origin: [1, 2, 3], velocity: [0, 10, 0], kind: 'frag' }), true);
  assert.equal(grenade.staged.kind, 'frag');
  assert.deepEqual(grenade.staged.velocity, [0, 10, 0]);
});

test('pings round-trip into a smoothed RTT', () => {
  const bus = makeBus();
  let clock = 0;
  const now = () => clock;
  const hostMatch = makeHost(bus, { match: stubMatch(), now });
  const { client } = makeGuestClient(bus, 'PINGER', now);
  bus.drainHostOutbox();

  client.update({ position: [0, 60, 0], now: clock }); // sends pose + first ping.
  clock = 45; // the pong arrives 45 ms later.
  const drained = bus.drainHostOutbox();
  assert.equal(bus.countTypes(drained, MESSAGE.PONG), 1);
  assert.equal(client.pingMs, 45); // smoothed through the bus handler.
  assert.equal(hostMatch.guests.size, 1);
});

test('leaving guests leave the roster and bots top up', () => {
  const bus = makeBus();
  const now = () => 1000;
  const removed = [];
  const hostMatch = makeHost(bus, { match: stubMatch(), now, onGuestRemoved: (guest, reason) => removed.push([guest.id, reason]) });
  const { client } = makeGuestClient(bus, 'LEAVER', now);
  bus.drainHostOutbox();
  assert.equal(hostMatch.botTarget(), 6); // 8 seats minus host and guest.

  hostMatch.removeGuest(client.selfId, 'test');
  assert.equal(hostMatch.guests.size, 0);
  assert.equal(hostMatch.botTarget(), 7);
  assert.deepEqual(removed, [[client.selfId, 'test']]);
  bus.drainHostOutbox();
  assert.equal(client.players.size, 1); // the LEAVE pruned the guest client-side.
});

test('a returning identity is rewelcomed with the same seat', () => {
  const bus = makeBus();
  const now = () => 1000;
  const hostMatch = makeHost(bus, { match: stubMatch(), now });
  const { guest, client } = makeGuestClient(bus, 'RETURNER', now);
  bus.drainHostOutbox();
  const firstId = client.selfId;

  // Same identity says hello again (tab reload): no JOIN spam, same id.
  bus.host.handler({ type: MESSAGE.HELLO, id: 'x', v: 1, name: 'RETURNER' }, guest.identity);
  const drained = bus.drainHostOutbox();
  assert.equal(drained.length, 1); // only the WELCOME re-send.
  assert.equal(drained[0].message.yourId, firstId);
  assert.equal(hostMatch.guests.size, 1);
});

test('client and host state stay serializable', () => {
  const bus = makeBus();
  const now = () => 1000;
  const hostMatch = makeHost(bus, { match: stubMatch(), now });
  makeGuestClient(bus, 'SNAPSHOT', now);
  bus.drainHostOutbox();

  const hostState = JSON.parse(JSON.stringify(hostMatch.getState()));
  assert.equal(hostState.humans, 2);
  assert.equal(hostState.guests.length, 1);
  assert.equal(hostState.botTarget, 6);

  const idle = new NetClient({ name: 'SOLO' });
  const state = JSON.parse(JSON.stringify(idle.getState()));
  assert.equal(state.status, 'idle');
  assert.equal(state.selfId, null);
});
