'use strict';

const ModbusRTU = require('modbus-serial');

/**
 * Register map of the Vestel EVC04 (Modbus TCP spec, unit id 255, port 502).
 * Input registers are read with FC4, holding registers with FC3 / FC6.
 */
const REG = {
  // Input registers (read only)
  SERIAL: 100, // 25 regs, one ASCII char per register
  BRAND: 190, // 10 regs
  MODEL: 210, // 5 regs
  FIRMWARE: 230, // 50 regs
  NUMBER_OF_PHASES: 404, // 0 = 1-phase, 1 = 3-phase
  CHARGEPOINT_STATE: 1000,
  CHARGING_STATE: 1001, // 0 = not charging, 1 = charging
  EQUIPMENT_STATE: 1002,
  CABLE_STATE: 1004, // 0 = no cable, 1 = cable no car, 2 = car connected, 3 = car connected + locked
  CURRENT_L1: 1008, // mA
  CURRENT_L2: 1010,
  CURRENT_L3: 1012,
  VOLTAGE_L1: 1014, // V
  VOLTAGE_L2: 1016,
  VOLTAGE_L3: 1018,
  ACTIVE_POWER: 1020, // uint32, W
  METER_READING: 1036, // uint32, 0.1 kWh
  SESSION_ENERGY: 1502, // uint32, Wh
  SESSION_DURATION: 1508, // uint32, s
  SESSION_MAX_CURRENT: 1100, // A, min of 5004 / EVSE max / cable max
  EVSE_MAX_CURRENT: 1104, // A, maximum configured in the charger by the installer
  CABLE_MAX_CURRENT: 1106, // A

  // Holding registers (read / write)
  PHASE_SWITCH: 405, // 0 = 1-phase, 1 = 3-phase (firmware >= 3.187.0)
  FAILSAFE_TIMEOUT: 2002, // s
  CHARGING_CURRENT: 5004, // A, 0 = pause
  ALIVE: 6000, // EMS writes 1, charger resets to 0
};

const DEFAULTS = {
  port: 502,
  unitId: 255,
  timeout: 3000,
};

function regsToString(regs) {
  return regs
    .map(r => (r > 0 && r < 0x10000 ? String.fromCharCode(r & 0xff) : ''))
    .join('')
    .replace(/\0/g, '')
    .trim();
}

function toUint32(regs) {
  return ((regs[0] << 16) >>> 0) + regs[1];
}

class VestelClient {

  constructor({ host, port = DEFAULTS.port, unitId = DEFAULTS.unitId, timeout = DEFAULTS.timeout, log = () => {} }) {
    this.host = host;
    this.port = Number(port) || DEFAULTS.port;
    this.unitId = Number(unitId) || DEFAULTS.unitId;
    this.timeout = timeout;
    this.log = log;
    this.client = null;
    this._queue = Promise.resolve();
    this._connecting = null;
  }

  get isOpen() {
    return Boolean(this.client && this.client.isOpen);
  }

  async connect() {
    if (this.isOpen) return;
    if (this._connecting) return this._connecting;

    this._connecting = (async () => {
      await this._closeQuietly();
      const client = new ModbusRTU();
      await client.connectTCP(this.host, { port: this.port });
      client.setID(this.unitId);
      client.setTimeout(this.timeout);
      this.client = client;
      this.log(`Connected to ${this.host}:${this.port} (unit ${this.unitId})`);
    })();

    try {
      await this._connecting;
    } finally {
      this._connecting = null;
    }
  }

  async close() {
    await this._closeQuietly();
  }

  async _closeQuietly() {
    const { client } = this;
    this.client = null;
    if (!client) return;
    await new Promise(resolve => {
      try {
        client.close(() => resolve());
      } catch (err) {
        resolve();
      }
      setTimeout(resolve, 1000);
    });
  }

  /**
   * Run Modbus operations one at a time; the charger accepts only one master
   * and does not like overlapping requests.
   */
  _enqueue(fn) {
    const run = async () => {
      await this.connect();
      try {
        return await fn(this.client);
      } catch (err) {
        // Drop the connection on transport errors so the next call reconnects.
        if (!err || err.modbusCode === undefined) {
          await this._closeQuietly();
        }
        throw err;
      }
    };
    const result = this._queue.then(run, run);
    this._queue = result.catch(() => {});
    return result;
  }

  readInput(address, length = 1) {
    return this._enqueue(async c => (await c.readInputRegisters(address, length)).data);
  }

  readHolding(address, length = 1) {
    return this._enqueue(async c => (await c.readHoldingRegisters(address, length)).data);
  }

  writeHolding(address, value) {
    return this._enqueue(c => c.writeRegister(address, value));
  }

  async readInfo() {
    const info = {};
    const tryRead = async (key, fn) => {
      try {
        info[key] = await fn();
      } catch (err) {
        this.log(`Could not read ${key}: ${err.message}`);
      }
    };
    await tryRead('serial', async () => regsToString(await this.readInput(REG.SERIAL, 25)));
    await tryRead('brand', async () => regsToString(await this.readInput(REG.BRAND, 10)));
    await tryRead('model', async () => regsToString(await this.readInput(REG.MODEL, 5)));
    await tryRead('firmware', async () => regsToString(await this.readInput(REG.FIRMWARE, 50)));
    await tryRead('threePhase', async () => (await this.readInput(REG.NUMBER_OF_PHASES))[0] === 1);
    await tryRead('failsafeTimeout', async () => (await this.readHolding(REG.FAILSAFE_TIMEOUT))[0]);
    await tryRead('evseMaxCurrent', async () => (await this.readInput(REG.EVSE_MAX_CURRENT))[0]);
    await tryRead('cableMaxCurrent', async () => (await this.readInput(REG.CABLE_MAX_CURRENT))[0]);
    if (info.threePhase) {
      await tryRead('phaseSetting', () => this.readPhaseSetting());
    }
    return info;
  }

  /** 1 or 3: the phases the charger is set to use (register 405, firmware >= 3.187.0). */
  async readPhaseSetting() {
    return (await this.readHolding(REG.PHASE_SWITCH, 1))[0] === 1 ? 3 : 1;
  }

  setPhases(phases) {
    return this.writeHolding(REG.PHASE_SWITCH, phases === 1 ? 0 : 1);
  }

  async readStatus({ phaseSwitch = false } = {}) {
    const one = async addr => (await this.readInput(addr, 1))[0];
    const two = async addr => toUint32(await this.readInput(addr, 2));

    const chargingState = await one(REG.CHARGING_STATE);
    const cableState = await one(REG.CABLE_STATE);
    const currents = [
      (await one(REG.CURRENT_L1)) / 1000,
      (await one(REG.CURRENT_L2)) / 1000,
      (await one(REG.CURRENT_L3)) / 1000,
    ];
    const voltages = [
      await one(REG.VOLTAGE_L1),
      await one(REG.VOLTAGE_L2),
      await one(REG.VOLTAGE_L3),
    ];
    const power = await two(REG.ACTIVE_POWER);
    const meterKwh = (await two(REG.METER_READING)) / 10;
    const sessionKwh = (await two(REG.SESSION_ENERGY)) / 1000;
    const sessionSeconds = await two(REG.SESSION_DURATION);
    const currentSetpoint = (await this.readHolding(REG.CHARGING_CURRENT, 1))[0];
    const phaseSetting = phaseSwitch ? await this.readPhaseSetting() : null;

    return {
      charging: chargingState === 1,
      carConnected: cableState >= 2,
      cableState,
      currents,
      voltages,
      power,
      meterKwh,
      sessionKwh,
      sessionSeconds,
      currentSetpoint,
      phaseSetting,
    };
  }

  setChargingCurrent(amps) {
    const value = Math.max(0, Math.min(32, Math.round(amps)));
    return this.writeHolding(REG.CHARGING_CURRENT, value);
  }

  sendAlive() {
    return this.writeHolding(REG.ALIVE, 1);
  }

}

module.exports = { VestelClient, REG, regsToString, toUint32 };
