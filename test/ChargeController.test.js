'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ChargeController } = require('../lib/ChargeController');

const S = 1000;
const idleCar = { carConnected: true, charging: false, currents: [0, 0, 0], power: 0 };
const noCar = { carConnected: false, charging: false, currents: [0, 0, 0], power: 0 };

function grid(power, currents = null, at = 0) {
  return { power, currents, at };
}

test('off mode always pauses', () => {
  const c = new ChargeController();
  assert.strictEqual(c.decide({ now: 0, mode: 'off', userMax: 16, charger: idleCar, grid: null }).current, 0);
});

test('fast mode uses user max, capped by installation max', () => {
  const c = new ChargeController({ maxCurrent: 16 });
  assert.strictEqual(c.decide({ now: 0, mode: 'fast', userMax: 10, charger: idleCar, grid: null }).current, 10);
  const r = c.decide({ now: 0, mode: 'fast', userMax: 32, charger: idleCar, grid: null });
  assert.strictEqual(r.current, 16);
  assert.strictEqual(r.reason, 'hardware_max');
});

test('no car: fast keeps allowed current, solar pauses', () => {
  const c = new ChargeController();
  assert.strictEqual(c.decide({ now: 0, mode: 'fast', userMax: 12, charger: noCar, grid: null }).current, 12);
  assert.strictEqual(c.decide({ now: 0, mode: 'solar', userMax: 12, charger: noCar, grid: null }).current, 0);
});

test('solar waits for start delay, then charges on surplus', () => {
  const c = new ChargeController({ solarStartDelayS: 60, solarBufferW: 0, phases: 1 });
  // 2300 W export on 1 phase = 10 A
  let r = c.decide({ now: 0, mode: 'solar', userMax: 16, charger: idleCar, grid: grid(-2300, null, 0) });
  assert.strictEqual(r.current, 0);
  assert.strictEqual(r.reason, 'solar_waiting');
  r = c.decide({ now: 61 * S, mode: 'solar', userMax: 16, charger: idleCar, grid: grid(-2300, null, 61 * S) });
  assert.strictEqual(r.current, 10);
  assert.strictEqual(r.reason, 'solar');
});

test('solar counts the charger\'s own consumption as surplus', () => {
  const c = new ChargeController({ solarStartDelayS: 0, solarBufferW: 0, phases: 3 });
  // Car charging 3 x 8 A = 5520 W, grid still exporting 1380 W -> 6900 W surplus = 10 A on 3 phases
  const charging = { carConnected: true, charging: true, currents: [8, 8, 8], power: 5520 };
  const r = c.decide({ now: 0, mode: 'solar', userMax: 16, charger: charging, grid: grid(-1380, null, 0) });
  assert.strictEqual(r.current, 10);
});

test('solar stops only after stop delay', () => {
  const c = new ChargeController({ solarStartDelayS: 0, solarStopDelayS: 300, solarBufferW: 0, phases: 1, increaseHoldS: 0 });
  c.decide({ now: 0, mode: 'solar', userMax: 16, charger: idleCar, grid: grid(-2300, null, 0) });
  // Cloud: importing now. Keep minimum current during stop delay.
  let r = c.decide({ now: 10 * S, mode: 'solar', userMax: 16, charger: idleCar, grid: grid(500, null, 10 * S) });
  assert.strictEqual(r.current, 6);
  r = c.decide({ now: 320 * S, mode: 'solar', userMax: 16, charger: idleCar, grid: grid(500, null, 320 * S) });
  assert.strictEqual(r.current, 0);
});

test('min_solar never drops below minimum', () => {
  const c = new ChargeController({ phases: 1 });
  const r = c.decide({ now: 0, mode: 'min_solar', userMax: 16, charger: idleCar, grid: grid(1000, null, 0) });
  assert.strictEqual(r.current, 6);
  assert.strictEqual(r.reason, 'solar_minimum');
});

test('solar without fresh grid data pauses, min_solar falls back to minimum', () => {
  const c = new ChargeController({ gridTimeoutS: 60 });
  const stale = grid(-5000, null, 0);
  assert.strictEqual(c.decide({ now: 120 * S, mode: 'solar', userMax: 16, charger: idleCar, grid: stale }).current, 0);
  assert.strictEqual(c.decide({ now: 120 * S, mode: 'min_solar', userMax: 16, charger: idleCar, grid: stale }).current, 6);
});

test('load balancing limits to headroom on busiest phase', () => {
  const c = new ChargeController({ loadBalancing: true, mainFuseA: 25, maxCurrent: 16 });
  const charging = { carConnected: true, charging: true, currents: [16, 16, 16], power: 11000 };
  // L2 has 24 A total of which 16 is the car -> 8 A household. Allowed car current = 16 + (25 - 24) = 17
  let r = c.decide({ now: 0, mode: 'fast', userMax: 16, charger: charging, grid: grid(11000, [20, 24, 18], 0) });
  assert.strictEqual(r.current, 16);
  // Oven turns on: L2 at 30 A -> 16 + (25 - 30) = 11
  r = c.decide({ now: 5 * S, mode: 'fast', userMax: 16, charger: charging, grid: grid(13000, [20, 30, 18], 5 * S) });
  assert.strictEqual(r.current, 11);
  assert.strictEqual(r.reason, 'load_balancing');
});

test('load balancing ignores phases the car does not use', () => {
  const c = new ChargeController({ loadBalancing: true, mainFuseA: 25, maxCurrent: 16 });
  const onePhase = { carConnected: true, charging: true, currents: [16, 0, 0], power: 3680 };
  const r = c.decide({ now: 0, mode: 'fast', userMax: 16, charger: onePhase, grid: grid(5000, [18, 30, 5], 0) });
  assert.strictEqual(r.current, 16);
});

test('load balancing pauses when headroom is below minimum', () => {
  const c = new ChargeController({ loadBalancing: true, mainFuseA: 25 });
  const charging = { carConnected: true, charging: true, currents: [10, 10, 10], power: 6900 };
  const r = c.decide({ now: 0, mode: 'fast', userMax: 16, charger: charging, grid: grid(15000, [30, 30, 30], 0) });
  assert.strictEqual(r.current, 0);
});

test('load balancing without grid data falls back to minimum', () => {
  const c = new ChargeController({ loadBalancing: true });
  const r = c.decide({ now: 0, mode: 'fast', userMax: 16, charger: idleCar, grid: null });
  assert.strictEqual(r.current, 6);
  assert.strictEqual(r.reason, 'no_grid_data');
});

test('does not climb back up right after a decrease', () => {
  const c = new ChargeController({ loadBalancing: true, mainFuseA: 25, increaseHoldS: 30 });
  const charging = { carConnected: true, charging: true, currents: [16, 16, 16], power: 11000 };
  c.decide({ now: 0, mode: 'fast', userMax: 16, charger: charging, grid: grid(0, [16, 16, 16], 0) });
  c.decide({ now: 5 * S, mode: 'fast', userMax: 16, charger: charging, grid: grid(0, [30, 30, 30], 5 * S) }); // -> 11
  const throttled = { ...charging, currents: [11, 11, 11] };
  let r = c.decide({ now: 10 * S, mode: 'fast', userMax: 16, charger: throttled, grid: grid(0, [11, 11, 11], 10 * S) });
  assert.strictEqual(r.current, 11);
  r = c.decide({ now: 40 * S, mode: 'fast', userMax: 16, charger: throttled, grid: grid(0, [11, 11, 11], 40 * S) });
  assert.strictEqual(r.current, 16);
});
