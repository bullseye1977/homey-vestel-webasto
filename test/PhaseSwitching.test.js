'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ChargeController } = require('../lib/ChargeController');

const S = 1000;
const base = {
  phaseSwitchAvailable: true, phaseMode: 'auto', phaseSwitchDelayS: 300, phaseSwitchMinIntervalS: 600,
  solarBufferW: 0, solarStartDelayS: 0, solarStopDelayS: 300,
};
const car = (phaseSetting, extra = {}) => ({
  carConnected: true, charging: false, currents: [0, 0, 0], power: 0, phaseSetting, ...extra,
});
const grid = (power, at) => ({ power, currents: null, at });

test('no switching when not available or in fixed mode', () => {
  let c = new ChargeController({ ...base, phaseSwitchAvailable: false });
  assert.strictEqual(c.decide({ now: 0, mode: 'solar', userMax: 16, charger: car(3), grid: grid(-2000, 0) }).wantedPhases, null);
  c = new ChargeController({ ...base, phaseMode: '1' });
  assert.strictEqual(c.decide({ now: 0, mode: 'fast', userMax: 16, charger: car(3), grid: null }).wantedPhases, 1);
  c = new ChargeController({ ...base, phaseMode: '3' });
  assert.strictEqual(c.decide({ now: 0, mode: 'solar', userMax: 16, charger: car(1), grid: grid(-2000, 0) }).wantedPhases, 3);
});

test('auto: fast mode always wants 3 phases', () => {
  const c = new ChargeController(base);
  assert.strictEqual(c.decide({ now: 0, mode: 'fast', userMax: 16, charger: car(1), grid: null }).wantedPhases, 3);
});

test('auto: solar without car prepares 1 phase', () => {
  const c = new ChargeController(base);
  const r = c.decide({ now: 0, mode: 'solar', userMax: 16, charger: { ...car(3), carConnected: false }, grid: null });
  assert.strictEqual(r.wantedPhases, 1);
});

test('auto: small surplus on 3 phases switches down to 1 after delay', () => {
  const c = new ChargeController(base);
  // 2000 W surplus: too little for 3 x 6 A (4140 W), enough for 1 x 8 A
  let r = c.decide({ now: 0, mode: 'solar', userMax: 16, charger: car(3), grid: grid(-2000, 0) });
  assert.strictEqual(r.wantedPhases, null);
  r = c.decide({ now: 301 * S, mode: 'solar', userMax: 16, charger: car(3), grid: grid(-2000, 301 * S) });
  assert.strictEqual(r.wantedPhases, 1);
});

test('auto: large surplus on 1 phase switches up to 3 after delay, respecting min interval', () => {
  const c = new ChargeController(base);
  c.phasesSwitched(0);
  // Charging 1 x 16 A = 3680 W and still exporting 1500 W -> 5180 W surplus
  const charging = car(1, { charging: true, currents: [16, 0, 0], power: 3680 });
  let r = c.decide({ now: 100 * S, mode: 'solar', userMax: 16, charger: charging, grid: grid(-1500, 100 * S) });
  assert.strictEqual(r.wantedPhases, null, 'min interval not passed yet');
  r = c.decide({ now: 601 * S, mode: 'solar', userMax: 16, charger: charging, grid: grid(-1500, 601 * S) });
  assert.strictEqual(r.wantedPhases, null, 'delay just started');
  r = c.decide({ now: 902 * S, mode: 'solar', userMax: 16, charger: charging, grid: grid(-1500, 902 * S) });
  assert.strictEqual(r.wantedPhases, 3);
});

test('auto: a dip resets the delay', () => {
  const c = new ChargeController(base);
  c.decide({ now: 0, mode: 'solar', userMax: 16, charger: car(3), grid: grid(-2000, 0) });
  c.decide({ now: 200 * S, mode: 'solar', userMax: 16, charger: car(3), grid: grid(-5000, 200 * S) }); // sun is back
  const r = c.decide({ now: 400 * S, mode: 'solar', userMax: 16, charger: car(3), grid: grid(-2000, 400 * S) });
  assert.strictEqual(r.wantedPhases, null);
});

test('current is calculated for 1 phase when the charger is set to 1 phase', () => {
  const c = new ChargeController(base);
  // 2300 W surplus on 1 phase = 10 A
  const r = c.decide({ now: 0, mode: 'solar', userMax: 16, charger: car(1), grid: grid(-2300, 0) });
  assert.strictEqual(r.current, 10);
  assert.strictEqual(r.phases, 1);
});
