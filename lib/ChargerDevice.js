'use strict';

const Homey = require('homey');
const { VestelClient } = require('./VestelClient');
const { ChargeController, MODES, PHASE_MODES } = require('./ChargeController');

const CAPABILITIES = [
  'evcharger_charging',
  'evcharger_charging_state',
  'vestel_charge_mode',
  'vestel_target_current',
  'vestel_applied_current',
  'vestel_limit_reason',
  'measure_power',
  'meter_power',
  'meter_power.session',
  'vestel_session_duration',
  'vestel_phases',
  'measure_current.l1',
  'measure_current.l2',
  'measure_current.l3',
  'measure_voltage.l1',
  'measure_voltage.l2',
  'measure_voltage.l3',
];

const CONNECTION_KEYS = ['host', 'port', 'unitId'];
const MAX_FAILURES = 3;
const REASSERT_MS = 60 * 1000;
const PHASE_PAUSE_TIMEOUT_MS = 20 * 1000; // wait this long for the car to stop before switching
const PHASE_SETTLE_MS = 10 * 1000; // stay paused this long after switching
const PHASE_SWITCH_TIMEOUT_MS = 60 * 1000;
const PHASE_RETRY_MS = 10 * 60 * 1000;
const PHASE_SWITCH_MIN_FIRMWARE = [3, 187, 0];

function firmwareAtLeast(firmware, min) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(firmware || '');
  if (!m) return false;
  const v = m.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

class ChargerDevice extends Homey.Device {

  async onInit() {
    this.grid = null;
    this.lastStatus = null;
    this.failures = 0;
    this.pollTimer = null;
    this.heartbeatTimer = null;
    this.polling = false;
    this.lastWritten = null;
    this.lastWriteAt = 0;
    this.evseMax = null; // max current configured in the charger (register 1104)
    this.phaseSwitch = false; // charger can switch between 1 and 3 phases
    this.switching = null;
    this.phaseRetryAfter = 0;

    for (const cap of CAPABILITIES) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }

    const settings = this.getSettings();
    this.controller = new ChargeController(this._controllerSettings(settings));

    if (!MODES.includes(this.getCapabilityValue('vestel_charge_mode'))) {
      await this.setCapabilityValue('vestel_charge_mode', 'fast').catch(this.error);
    }
    if (typeof this.getCapabilityValue('vestel_target_current') !== 'number') {
      await this.setCapabilityValue('vestel_target_current', settings.maxCurrent || 16).catch(this.error);
    }
    await this._updateTargetCurrentRange(settings);

    this.registerCapabilityListener('vestel_charge_mode', mode => this.setChargeMode(mode, { fromUi: true }));
    this.registerCapabilityListener('vestel_target_current', value => this.setTargetCurrent(value, { fromUi: true }));
    this.registerCapabilityListener('evcharger_charging', on => {
      const mode = on ? (this.getStoreValue('lastActiveMode') || 'fast') : 'off';
      return this.setChargeMode(mode);
    });

    this._createClient(settings);
    await this._start();
  }

  /** Installation max from settings, never above what the charger itself allows. */
  _effectiveMax(s) {
    const configured = Number(s.maxCurrent) || 16;
    return this.evseMax ? Math.min(configured, this.evseMax) : configured;
  }

  _controllerSettings(s) {
    return {
      minCurrent: Number(s.minCurrent) || 6,
      maxCurrent: this._effectiveMax(s),
      phaseSwitchAvailable: this.phaseSwitch,
      phaseMode: PHASE_MODES.includes(s.phaseMode) ? s.phaseMode : '3',
      phaseSwitchDelayS: Number(s.phaseSwitchDelayS) || 300,
      phases: Number(s.phases) || 3,
      solarBufferW: Number(s.solarBufferW) || 0,
      solarStartDelayS: Number(s.solarStartDelayS) || 0,
      solarStopDelayS: Number(s.solarStopDelayS) || 0,
      solarAdjustIntervalS: Number(s.solarAdjustIntervalS) || 30,
      loadBalancing: Boolean(s.loadBalancing),
      mainFuseA: Number(s.mainFuseA) || 25,
      gridTimeoutS: Number(s.gridTimeoutS) || 60,
    };
  }

  async _updateTargetCurrentRange(settings) {
    const min = Number(settings.minCurrent) || 6;
    const max = this._effectiveMax(settings);
    await this.setCapabilityOptions('vestel_target_current', { min, max, step: 1 }).catch(this.error);
    const current = this.getCapabilityValue('vestel_target_current');
    if (current > max || current < min) {
      await this.setCapabilityValue('vestel_target_current', Math.min(max, Math.max(min, current))).catch(this.error);
    }
  }

  _createClient(settings) {
    this.client = new VestelClient({
      host: settings.host,
      port: settings.port,
      unitId: settings.unitId,
      log: (...args) => this.log(...args),
    });
  }

  async _start() {
    this._stop();
    const settings = this.getSettings();
    if (!settings.host) {
      await this.setUnavailable(this.homey.__('error.no_host')).catch(this.error);
      return;
    }

    let heartbeatS = 5;
    try {
      const info = await this.client.readInfo();
      if (info.failsafeTimeout > 0) heartbeatS = Math.max(1, Math.floor(info.failsafeTimeout / 4));
      const updates = {};
      if (info.serial && info.serial !== settings.serial) updates.serial = info.serial;
      if (info.firmware && info.firmware !== settings.firmware) updates.firmware = info.firmware;

      if (info.evseMaxCurrent >= 6 && info.evseMaxCurrent <= 80) {
        this.evseMax = info.evseMaxCurrent;
        const label = `${info.evseMaxCurrent} A`;
        if (settings.evseMaxCurrent !== label) updates.evseMaxCurrent = label;
        if (Number(settings.maxCurrent) > this.evseMax) {
          this.log(`Installation max ${settings.maxCurrent} A is above the charger's own max ${this.evseMax} A; using ${this.evseMax} A`);
        }
      }

      this.phaseSwitch = Boolean(info.threePhase && (info.phaseSetting === 1 || info.phaseSetting === 3)
        && firmwareAtLeast(info.firmware, PHASE_SWITCH_MIN_FIRMWARE));
      const phaseLabel = this.homey.__(this.phaseSwitch ? 'phase.supported' : 'phase.not_supported');
      if (settings.phaseSwitchSupport !== phaseLabel) updates.phaseSwitchSupport = phaseLabel;

      if (Object.keys(updates).length) await this.setSettings(updates).catch(this.error);
      this.log('Charger info', info, `phase switching ${this.phaseSwitch ? 'available' : 'not available'}`);
      this.controller.updateSettings(this._controllerSettings(this.getSettings()));
      await this._updateTargetCurrentRange(this.getSettings());
    } catch (err) {
      this.error('Could not read charger info, will keep retrying', err.message);
    }

    // The charger falls back to its failsafe current when it stops hearing from us.
    this.heartbeatTimer = this.homey.setInterval(() => {
      this.client.sendAlive().catch(err => this.log('Heartbeat failed:', err.message));
    }, heartbeatS * 1000);

    const pollMs = Math.max(2, Number(settings.pollInterval) || 5) * 1000;
    this.pollTimer = this.homey.setInterval(() => this._poll(), pollMs);
    this._poll();
  }

  _stop() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    if (this.heartbeatTimer) this.homey.clearInterval(this.heartbeatTimer);
    this.pollTimer = null;
    this.heartbeatTimer = null;
  }

  async reconnect() {
    this._stop();
    if (this.client) await this.client.close();
    this._createClient(this.getSettings());
    this.controller.reset();
    this.lastWritten = null;
    this.switching = null;
    await this._start();
  }

  async _poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const status = await this.client.readStatus({ phaseSwitch: this.phaseSwitch });
      this.failures = 0;
      if (!this.getAvailable()) await this.setAvailable().catch(this.error);

      let decision = this.controller.decide({
        now: Date.now(),
        mode: this.getCapabilityValue('vestel_charge_mode'),
        userMax: this.getCapabilityValue('vestel_target_current'),
        charger: status,
        grid: this.grid,
      });
      if (await this._handlePhaseSwitch(status, decision.wantedPhases)) {
        decision = { ...decision, current: 0, reason: 'phase_switching' };
      }

      // Write on change, and re-assert once a minute in case the charger restarted.
      // Don't compare with the read-back value: some firmware reports 6 A after we write 0 A.
      const changed = decision.current !== this.lastWritten;
      if (changed || Date.now() - this.lastWriteAt > REASSERT_MS) {
        if (changed) {
          this.log(`Setpoint -> ${decision.current} A (${decision.reason}), charger reported ${status.currentSetpoint} A`);
        }
        await this.client.setChargingCurrent(decision.current);
        this.lastWritten = decision.current;
        this.lastWriteAt = Date.now();
      }

      await this._publish(status, decision);
      this.lastStatus = status;
    } catch (err) {
      this.failures += 1;
      this.error(`Poll failed (${this.failures}x):`, err.message);
      if (this.failures >= MAX_FAILURES && this.getAvailable()) {
        await this.setUnavailable(this.homey.__('error.unreachable', { error: err.message })).catch(this.error);
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * Switch between 1 and 3 phases safely: pause, wait until the car stopped, switch,
   * stay paused a few seconds, then let normal control resume.
   * @returns {boolean} true while a switch is in progress (charging must stay paused)
   */
  async _handlePhaseSwitch(status, wanted) {
    if (!this.phaseSwitch) return false;
    const now = Date.now();
    const sw = this.switching;

    if (sw) {
      if (sw.stage === 'pausing') {
        if (!status.charging || now - sw.since > PHASE_PAUSE_TIMEOUT_MS) {
          await this.client.setPhases(sw.target);
          this.log(`Phase switch: charger set to ${sw.target} phase(s)`);
          this.switching = { ...sw, stage: 'settling', since: now };
        }
        return true;
      }
      if (status.phaseSetting === sw.target && now - sw.since >= PHASE_SETTLE_MS) {
        this.log(`Phase switch to ${sw.target} phase(s) done`);
        this.switching = null;
        this.controller.phasesSwitched(now);
        return false;
      }
      if (now - sw.since > PHASE_SWITCH_TIMEOUT_MS) {
        this.error(`Phase switch to ${sw.target} did not take effect (charger reports ${status.phaseSetting}); retrying in 10 min`);
        this.switching = null;
        this.phaseRetryAfter = now + PHASE_RETRY_MS;
        this.controller.phasesSwitched(now);
        return false;
      }
      return true;
    }

    if (!wanted || !status.phaseSetting || wanted === status.phaseSetting || now < this.phaseRetryAfter) return false;

    if (!status.carConnected) {
      // Nothing is charging, so switch right away.
      this.log(`Phase switch (no car): ${status.phaseSetting} -> ${wanted} phase(s)`);
      await this.client.setPhases(wanted);
      return false;
    }
    this.log(`Phase switch: ${status.phaseSetting} -> ${wanted} phase(s), pausing charging first`);
    this.switching = { target: wanted, stage: 'pausing', since: now };
    return true;
  }

  async _publish(status, decision) {
    let state = 'plugged_out';
    if (status.carConnected) {
      if (status.charging) state = 'plugged_in_charging';
      else if (decision.current === 0) state = 'plugged_in_paused';
      else state = 'plugged_in';
    }

    const values = {
      evcharger_charging_state: state,
      evcharger_charging: this.getCapabilityValue('vestel_charge_mode') !== 'off',
      vestel_applied_current: decision.current,
      vestel_limit_reason: this.homey.__(`reason.${decision.reason}`),
      measure_power: status.power,
      meter_power: status.meterKwh,
      'meter_power.session': status.sessionKwh,
      vestel_session_duration: Math.round(status.sessionSeconds / 60),
      vestel_phases: decision.phases,
      'measure_current.l1': status.currents[0],
      'measure_current.l2': status.currents[1],
      'measure_current.l3': status.currents[2],
      'measure_voltage.l1': status.voltages[0],
      'measure_voltage.l2': status.voltages[1],
      'measure_voltage.l3': status.voltages[2],
    };

    for (const [cap, value] of Object.entries(values)) {
      if (this.getCapabilityValue(cap) !== value) {
        await this.setCapabilityValue(cap, value).catch(this.error);
      }
    }

    const prev = this.lastStatus;
    if (prev && !prev.carConnected && status.carConnected) {
      await this.homey.flow.getDeviceTriggerCard('car_connected').trigger(this).catch(this.error);
    }
    if (prev && prev.carConnected && !status.carConnected) {
      // Use the last values before unplugging; some firmware resets them on disconnect.
      const energy = Math.max(prev.sessionKwh, status.sessionKwh);
      const duration = Math.round(Math.max(prev.sessionSeconds, status.sessionSeconds) / 60);
      await this.homey.flow.getDeviceTriggerCard('car_disconnected')
        .trigger(this, { energy, duration }).catch(this.error);
    }
  }

  async setChargeMode(mode, { fromUi = false } = {}) {
    if (!MODES.includes(mode)) throw new Error(`Unknown mode ${mode}`);
    const previous = this.getCapabilityValue('vestel_charge_mode');
    if (mode !== 'off') await this.setStoreValue('lastActiveMode', mode).catch(this.error);
    if (!fromUi) await this.setCapabilityValue('vestel_charge_mode', mode);
    await this.setCapabilityValue('evcharger_charging', mode !== 'off').catch(this.error);
    if (previous !== mode) {
      this.controller.reset();
      await this.homey.flow.getDeviceTriggerCard('charge_mode_changed').trigger(this, { mode }).catch(this.error);
    }
    // Apply right away instead of waiting for the next poll.
    this.homey.setTimeout(() => this._poll(), 100);
  }

  async setTargetCurrent(value, { fromUi = false } = {}) {
    const s = this.getSettings();
    const amps = Math.round(Math.min(this._effectiveMax(s), Math.max(Number(s.minCurrent) || 6, Number(value))));
    if (!fromUi || amps !== value) await this.setCapabilityValue('vestel_target_current', amps);
    this.homey.setTimeout(() => this._poll(), 100);
  }

  async setPhaseMode(mode) {
    if (!PHASE_MODES.includes(mode)) throw new Error(`Unknown phase mode ${mode}`);
    if (!this.phaseSwitch && mode !== '3') throw new Error(this.homey.__('phase.not_supported'));
    await this.setSettings({ phaseMode: mode });
    this.controller.updateSettings(this._controllerSettings(this.getSettings()));
    this.homey.setTimeout(() => this._poll(), 100);
  }

  /** Called by the grid flow cards with data from the P1 meter. */
  async updateGrid({ power, currents = null }) {
    if (typeof power !== 'number' || Number.isNaN(power)) throw new Error('Invalid grid power');
    const cleanCurrents = Array.isArray(currents)
      ? currents.map(a => (typeof a === 'number' && !Number.isNaN(a) ? a : null))
      : (this.grid && this.grid.currents) || null;
    this.grid = { power, currents: cleanCurrents, at: Date.now() };
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('phaseMode') && newSettings.phaseMode !== '3' && !this.phaseSwitch) {
      throw new Error(this.homey.__('phase.not_supported'));
    }
    this.controller.updateSettings(this._controllerSettings(newSettings));
    if (changedKeys.includes('minCurrent') || changedKeys.includes('maxCurrent')) {
      // Settings are saved after this returns, so pass the new values explicitly.
      this.homey.setTimeout(() => this._updateTargetCurrentRange(newSettings), 500);
    }
    if (changedKeys.some(k => CONNECTION_KEYS.includes(k) || k === 'pollInterval')) {
      this.homey.setTimeout(() => this.reconnect().catch(this.error), 500);
    }
  }

  async onUninit() {
    this._stop();
    if (this.client) await this.client.close();
  }

  async onDeleted() {
    await this.onUninit();
  }

}

module.exports = ChargerDevice;
