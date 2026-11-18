'use strict';

/**
 * Pure decision logic: which charging current should the charger get right now?
 * No I/O, so it can be unit tested. Call `decide()` once per poll cycle.
 *
 * Sign convention for grid data (same as most P1 meters):
 *   power > 0 = importing from the grid, power < 0 = exporting (solar surplus)
 *   currents per phase: > 0 import, < 0 export
 */

const MODES = ['fast', 'min_solar', 'solar', 'off'];

const REASONS = {
  OFF: 'off',
  NO_CAR: 'no_car',
  USER_MAX: 'user_max',
  SOLAR: 'solar',
  SOLAR_WAITING: 'solar_waiting',
  SOLAR_MINIMUM: 'solar_minimum',
  NO_GRID_DATA: 'no_grid_data',
  LOAD_BALANCING: 'load_balancing',
  HARDWARE_MAX: 'hardware_max',
};

const DEFAULT_SETTINGS = {
  minCurrent: 6,
  maxCurrent: 16, // hardware / installation limit of the charger
  phases: 3, // used when it cannot be measured
  voltage: 230,
  solarBufferW: 100,
  solarStartDelayS: 120,
  solarStopDelayS: 300,
  solarAdjustIntervalS: 30,
  loadBalancing: false,
  mainFuseA: 25,
  increaseHoldS: 30,
  gridTimeoutS: 60,
};

class ChargeController {

  constructor(settings = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.reset();
  }

  updateSettings(settings) {
    this.settings = { ...this.settings, ...settings };
  }

  reset() {
    this.solarActive = false;
    this.solarAboveSince = null;
    this.solarBelowSince = null;
    this.lastSolarCurrent = null;
    this.lastSolarChangeAt = 0;
    this.lastOutput = 0;
    this.lastLoadBalanceDecreaseAt = -Infinity;
  }

  /**
   * @param {object} input
   * @param {number} input.now - ms timestamp
   * @param {string} input.mode - one of MODES
   * @param {number} input.userMax - the max current the user picked (A)
   * @param {object} input.charger - { carConnected, charging, currents[3], power }
   * @param {object|null} input.grid - { power, currents[3]|null, at }
   * @returns {{ current: number, reason: string, phases: number }}
   */
  decide({ now, mode, userMax, charger, grid }) {
    const s = this.settings;
    const phases = this._phases(charger);

    if (mode === 'off') {
      this._resetSolar();
      return this._out(0, REASONS.OFF, phases, now);
    }
    if (!charger.carConnected) {
      this._resetSolar();
      // Keep the setpoint at "allowed" level so the car starts immediately when plugged in
      // (fast mode) or stays paused until there is surplus (solar modes).
      const idle = mode === 'fast' ? Math.min(userMax, s.maxCurrent) : (mode === 'min_solar' ? s.minCurrent : 0);
      return this._out(idle, REASONS.NO_CAR, phases, now);
    }

    const gridFresh = Boolean(grid && typeof grid.power === 'number' && now - grid.at <= s.gridTimeoutS * 1000);

    // 1. What does the chosen mode want?
    let wanted;
    let reason;
    if (mode === 'fast') {
      wanted = userMax;
      reason = REASONS.USER_MAX;
    } else {
      ({ wanted, reason } = this._solar(mode, now, charger, grid, gridFresh, phases, userMax));
    }

    if (wanted <= 0) return this._out(0, reason, phases, now);

    // 2. Hardware limit
    if (wanted > s.maxCurrent) {
      wanted = s.maxCurrent;
      reason = REASONS.HARDWARE_MAX;
    }

    // 3. Load balancing (capacity protection of the main fuse)
    if (s.loadBalancing) {
      const limit = this._loadBalanceLimit(charger, grid, gridFresh);
      if (limit < wanted) {
        wanted = limit;
        reason = gridFresh ? REASONS.LOAD_BALANCING : REASONS.NO_GRID_DATA;
      }
    }

    wanted = Math.floor(wanted);
    if (wanted < s.minCurrent) return this._out(0, reason, phases, now);

    // Don't climb back up right after load balancing had to throttle (prevents oscillation).
    if (wanted > this.lastOutput && this.lastOutput > 0 && now - this.lastLoadBalanceDecreaseAt < s.increaseHoldS * 1000) {
      return this._out(this.lastOutput, reason, phases, now);
    }

    return this._out(wanted, reason, phases, now);
  }

  _solar(mode, now, charger, grid, gridFresh, phases, userMax) {
    const s = this.settings;

    if (!gridFresh) {
      this._resetSolar();
      return mode === 'min_solar'
        ? { wanted: s.minCurrent, reason: REASONS.NO_GRID_DATA }
        : { wanted: 0, reason: REASONS.NO_GRID_DATA };
    }

    // Surplus = what we export now + what the charger itself already uses.
    const surplusW = (charger.power || 0) - grid.power - s.solarBufferW;
    const possible = Math.floor(surplusW / (s.voltage * phases));
    const capped = Math.min(possible, userMax);

    if (mode === 'min_solar') {
      this.solarActive = true;
      if (capped <= s.minCurrent) return { wanted: s.minCurrent, reason: REASONS.SOLAR_MINIMUM };
      return { wanted: this._smoothSolar(capped, now), reason: REASONS.SOLAR };
    }

    // mode === 'solar': start/stop with delays so clouds don't toggle the car every minute.
    if (possible >= s.minCurrent) {
      this.solarBelowSince = null;
      if (!this.solarActive) {
        if (this.solarAboveSince === null) this.solarAboveSince = now;
        if (now - this.solarAboveSince >= s.solarStartDelayS * 1000) {
          this.solarActive = true;
          this.lastSolarChangeAt = 0;
        }
      }
    } else {
      this.solarAboveSince = null;
      if (this.solarActive) {
        if (this.solarBelowSince === null) this.solarBelowSince = now;
        if (now - this.solarBelowSince >= s.solarStopDelayS * 1000) {
          this.solarActive = false;
          this.lastSolarCurrent = null;
        }
      }
    }

    if (!this.solarActive) return { wanted: 0, reason: REASONS.SOLAR_WAITING };
    return { wanted: this._smoothSolar(Math.max(capped, s.minCurrent), now), reason: REASONS.SOLAR };
  }

  /** Only change the solar current every `solarAdjustIntervalS`, except when it must drop a lot. */
  _smoothSolar(target, now) {
    const s = this.settings;
    if (this.lastSolarCurrent === null
      || now - this.lastSolarChangeAt >= s.solarAdjustIntervalS * 1000
      || target < this.lastSolarCurrent - 2) {
      if (target !== this.lastSolarCurrent) this.lastSolarChangeAt = now;
      this.lastSolarCurrent = target;
    }
    return this.lastSolarCurrent;
  }

  _loadBalanceLimit(charger, grid, gridFresh) {
    const s = this.settings;
    if (!gridFresh || !Array.isArray(grid.currents)) return s.minCurrent;

    const chargerCurrents = charger.currents || [0, 0, 0];
    const charging = chargerCurrents.some(a => a > 1);
    let limit = Infinity;
    for (let i = 0; i < 3; i++) {
      const gridA = grid.currents[i];
      if (typeof gridA !== 'number') continue;
      // While charging only the phases the car actually uses matter.
      if (charging && !(chargerCurrents[i] > 1)) continue;
      const headroom = s.mainFuseA - gridA;
      limit = Math.min(limit, (chargerCurrents[i] || 0) + headroom);
    }
    return limit === Infinity ? s.minCurrent : Math.floor(limit);
  }

  _phases(charger) {
    const measured = (charger.currents || []).filter(a => a > 1).length;
    if (charger.charging && measured > 0) return measured;
    return this.settings.phases;
  }

  _resetSolar() {
    this.solarActive = false;
    this.solarAboveSince = null;
    this.solarBelowSince = null;
    this.lastSolarCurrent = null;
    this.lastSolarChangeAt = 0;
  }

  _out(current, reason, phases, now) {
    if (current < this.lastOutput && (reason === REASONS.LOAD_BALANCING || reason === REASONS.NO_GRID_DATA)) {
      this.lastLoadBalanceDecreaseAt = now;
    }
    this.lastOutput = current;
    return { current, reason, phases };
  }

}

module.exports = { ChargeController, MODES, REASONS, DEFAULT_SETTINGS };
