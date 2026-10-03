import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HOST_ID, MESSAGE, isNoisyType, isRoomCode, isValidMessage, makeHello,
  makePlayerId, makePose, makeRoomCode, makeShot, makeWelcome, readPose,
  readShot, sanitizeName, sanitizePlayer,
} from '../export/web/net/protocol.js';

test('room codes are four unambiguous capitals and validate strictly', () => {
  for (let i = 0; i < 50; i += 1) {
    const code = makeRoomCode();
    assert.ok(isRoomCode(code), code);
    assert.ok(!/[ILOU01]/.test(code), code);
  }
  assert.equal(isRoomCode('AB23'), true);
  assert.equal(isRoomCode('ab23'), false);
  assert.equal(isRoomCode('AB2'), false);
  assert.equal(isRoomCode('AB201'), false);
  assert.equal(isRoomCode(null), false);
});

test('player ids are stable-shaped tokens and the host id is fixed', () => {
  const id = makePlayerId();
  assert.match(id, /^p[a-z0-9]{5}$/);
  assert.notEqual(makePlayerId(), id);
  assert.equal(HOST_ID, 'host');
});

test('names are trimmed, uppercased, capped and fallback-safe', () => {
  assert.equal(sanitizeName('  rambo  '), 'RAMBO');
  assert.equal(sanitizeName('una cantidad enorme de caracteres'), 'PLAYER');
  assert.equal(sanitizeName(''), 'PLAYER');
  assert.equal(sanitizeName(null), 'PLAYER');
  assert.equal(sanitizeName('<script>'), 'PLAYER'); // symbols stripped.
  assert.equal(sanitizeName('Ñandú-1'), 'ÑANDÚ-1');
  assert.equal(sanitizeName(42), 'PLAYER'); // non-strings never pass.
});

test('poses round-trip and malformed poses are rejected', () => {
  const pose = makePose({ position: [10.44, 60, -3.25], yaw: 1.234, speed: 210.7, scoped: true, tick: 7 });
  assert.deepEqual(pose, {
    type: 'pose', p: [10.4, 60, -3.2], yaw: 1.23, speed: 211,
    scoped: true, crouch: false, dead: false, tick: 7,
  });
  const read = readPose(pose);
  assert.deepEqual(read.position, [10.4, 60, -3.2]);
  assert.equal(read.yaw, 1.23);
  assert.equal(read.speed, 211);
  assert.equal(read.tick, 7);

  assert.equal(readPose(null), null);
  assert.equal(readPose({ p: [1, 2] }), null);
  assert.equal(readPose({ p: [1, 'x', 3] }), null);
  assert.equal(readPose({}), null);
});

test('shots round-trip, directions normalize, junk is rejected', () => {
  const shot = makeShot({ origin: [1.11, 2.22, 3.33], direction: [0, 2, 0], weapon: 'smg', tick: 44, seq: 5 });
  const read = readShot(shot);
  assert.deepEqual(read.origin, [1.1, 2.2, 3.3]);
  assert.deepEqual(read.direction, [0, 1, 0]);
  assert.equal(read.weapon, 'smg');
  assert.equal(read.tick, 44);
  assert.equal(read.seq, 5);

  assert.equal(readShot(null), null);
  assert.equal(readShot({ o: [1, 2, 3], d: [0, 0, 0] }), null);
  assert.equal(readShot({ o: [1, 2, 3], d: [0, 99, 0] }), null); // not unit-ish.
  assert.equal(readShot({ o: [1, 2], d: [0, 1, 0] }), null);
});

test('hello and welcome carry sanitized, structured data', () => {
  const hello = makeHello({ name: ' guest one ' });
  assert.equal(hello.type, MESSAGE.HELLO);
  assert.equal(hello.v, 1);
  assert.equal(hello.name, 'GUEST ONE');
  assert.equal(hello.identity, null);

  const welcome = makeWelcome({
    yourId: 'pabc12',
    roomCode: 'AB23',
    roster: [{ id: 'pabc12', name: 'guest one' }, { id: HOST_ID, name: 'HOST', local: true }],
    matchState: { phase: 'playing' },
    hostTick: 33,
    now: 1000,
  });
  assert.equal(welcome.yourId, 'pabc12');
  assert.equal(welcome.hostId, HOST_ID);
  assert.equal(welcome.roster[1].team, 'ffa');
  assert.equal(welcome.roster[1].local, true);
  assert.equal(welcome.tick, 33);
  assert.equal(welcome.now, 1000);
});

test('sanitizePlayer coerces teams and flags', () => {
  assert.deepEqual(sanitizePlayer({ id: 'a', name: 'x', team: 'axis' }), { id: 'a', name: 'X', team: 'axis', human: true, local: false });
  assert.equal(sanitizePlayer({ id: 'a', name: 'x', team: 'red' }).team, 'ffa');
  assert.equal(sanitizePlayer({ id: 'a', name: 'x', human: false }).human, false);
});

test('validity and noise checks route packets safely', () => {
  assert.equal(isValidMessage({ type: 'pose', id: 'p1' }), true);
  assert.equal(isValidMessage({ type: 'nonsense', id: 'p1' }), false);
  assert.equal(isValidMessage({ type: 'pose' }), false);
  assert.equal(isValidMessage(null), false);
  assert.equal(isNoisyType(MESSAGE.POSE), true);
  assert.equal(isNoisyType(MESSAGE.DAMAGE), false);
});
