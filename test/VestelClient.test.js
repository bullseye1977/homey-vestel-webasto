'use strict';

// Talks to a simulated EVC04 over real Modbus TCP (modbus-serial's ServerTCP).
const test = require('node:test');
const assert = require('node:assert');
const ModbusRTU = require('modbus-serial');
const { VestelClient, REG } = require('../lib/VestelClient');

function str(s, len) {
  const regs = new Array(len).fill(0);
  [...s].forEach((ch, i) => { regs[i] = ch.charCodeAt(0); });
  return regs;
}

function startFakeCharger(port) {
  const input = {};
  const holding = { [REG.CHARGING_CURRENT]: 16, [REG.FAILSAFE_TIMEOUT]: 20, [REG.ALIVE]: 0 };
  str('EVC04SN123', 25).forEach((v, i) => { input[REG.SERIAL + i] = v; });
  str('VESTEL', 10).forEach((v, i) => { input[REG.BRAND + i] = v; });
  str('EVC04', 5).forEach((v, i) => { input[REG.MODEL + i] = v; });
  str('v3.187.0', 50).forEach((v, i) => { input[REG.FIRMWARE + i] = v; });
  Object.assign(input, {
    [REG.NUMBER_OF_PHASES]: 1,
    [REG.CHARGING_STATE]: 1,
    [REG.CABLE_STATE]: 3,
    [REG.CURRENT_L1]: 10500,
    [REG.CURRENT_L2]: 10400,
    [REG.CURRENT_L3]: 10300,
    [REG.VOLTAGE_L1]: 231,
    [REG.VOLTAGE_L2]: 232,
    [REG.VOLTAGE_L3]: 229,
    [REG.ACTIVE_POWER]: 0,
    [REG.ACTIVE_POWER + 1]: 7250,
    [REG.METER_READING]: 0,
    [REG.METER_READING + 1]: 8330, // 833.0 kWh
    [REG.SESSION_ENERGY]: 1, // 65536 + 4464 = 70000 Wh
    [REG.SESSION_ENERGY + 1]: 4464,
    [REG.SESSION_DURATION]: 0,
    [REG.SESSION_DURATION + 1]: 5400,
  });

  const vector = {
    getInputRegister: addr => input[addr] || 0,
    getHoldingRegister: addr => holding[addr] || 0,
    setRegister: (addr, value) => { holding[addr] = value; },
  };
  const server = new ModbusRTU.ServerTCP(vector, { host: '127.0.0.1', port, unitID: 255 });
  return { server, holding };
}

test('reads info, status and writes current + heartbeat', async () => {
  const port = 15020;
  const { server, holding } = startFakeCharger(port);
  await new Promise(r => server.on('initialized', r));
  const client = new VestelClient({ host: '127.0.0.1', port });

  try {
    const info = await client.readInfo();
    assert.strictEqual(info.serial, 'EVC04SN123');
    assert.strictEqual(info.brand, 'VESTEL');
    assert.strictEqual(info.model, 'EVC04');
    assert.strictEqual(info.firmware, 'v3.187.0');
    assert.strictEqual(info.threePhase, true);
    assert.strictEqual(info.failsafeTimeout, 20);

    const s = await client.readStatus();
    assert.strictEqual(s.charging, true);
    assert.strictEqual(s.carConnected, true);
    assert.deepStrictEqual(s.currents, [10.5, 10.4, 10.3]);
    assert.deepStrictEqual(s.voltages, [231, 232, 229]);
    assert.strictEqual(s.power, 7250);
    assert.strictEqual(s.meterKwh, 833);
    assert.strictEqual(s.sessionKwh, 70);
    assert.strictEqual(s.sessionSeconds, 5400);
    assert.strictEqual(s.currentSetpoint, 16);

    await client.setChargingCurrent(8);
    assert.strictEqual(holding[REG.CHARGING_CURRENT], 8);
    await client.setChargingCurrent(0);
    assert.strictEqual(holding[REG.CHARGING_CURRENT], 0);
    await client.sendAlive();
    assert.strictEqual(holding[REG.ALIVE], 1);

    // Parallel calls must be serialised and all succeed.
    const results = await Promise.all([client.readStatus(), client.readStatus(), client.sendAlive()]);
    assert.strictEqual(results[0].power, 7250);
  } finally {
    await client.close();
    await new Promise(r => server.close(r));
  }
});

test('reconnects after the connection drops', async () => {
  const port = 15021;
  let fake = startFakeCharger(port);
  await new Promise(r => fake.server.on('initialized', r));
  const client = new VestelClient({ host: '127.0.0.1', port, timeout: 1000 });
  try {
    assert.strictEqual((await client.readStatus()).power, 7250);
    await new Promise(r => fake.server.close(r));
    await assert.rejects(client.readStatus());
    fake = startFakeCharger(port);
    await new Promise(r => fake.server.on('initialized', r));
    assert.strictEqual((await client.readStatus()).power, 7250);
  } finally {
    await client.close();
    await new Promise(r => fake.server.close(r));
  }
});

test('does not hang when the charger drops the connection mid-request', async () => {
  const net = require('net');
  const port = 15022;
  const { server: real } = startFakeCharger(15023);
  await new Promise(r => real.on('initialized', r));

  // Proxy that forwards to the fake charger, but kills the socket on the 3rd request.
  let requests = 0;
  const proxy = net.createServer(sock => {
    const up = net.connect(15023, '127.0.0.1');
    sock.on('data', d => {
      requests += 1;
      if (requests === 3) { sock.destroy(); up.destroy(); return; }
      up.write(d);
    });
    up.on('data', d => sock.write(d));
    sock.on('error', () => {}); up.on('error', () => {});
  });
  await new Promise(r => proxy.listen(port, '127.0.0.1', r));

  const client = new VestelClient({ host: '127.0.0.1', port, timeout: 1000 });
  try {
    const started = Date.now();
    await assert.rejects(client.readStatus());
    assert.ok(Date.now() - started < 5000, 'failed fast instead of hanging');
    // Next call reconnects and works again.
    assert.strictEqual((await client.readStatus()).power, 7250);
  } finally {
    await client.close();
    await new Promise(r => proxy.close(r));
    await new Promise(r => real.close(r));
  }
});
