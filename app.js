'use strict';

const Homey = require('homey');

class ChargerApp extends Homey.App {

  async onInit() {
    this._registerFlowCards();
    this.log('Vestel EVC04 & Webasto Unite app started');
  }

  // Flow cards are shared by both drivers (EVC04 and Unite), so they are registered once here.
  _registerFlowCards() {
    const { flow } = this.homey;

    flow.getConditionCard('is_car_connected')
      .registerRunListener(({ device }) => device.getCapabilityValue('evcharger_charging_state') !== 'plugged_out');

    flow.getConditionCard('charge_mode_is')
      .registerRunListener(({ device, mode }) => device.getCapabilityValue('vestel_charge_mode') === mode);

    flow.getActionCard('set_charge_mode')
      .registerRunListener(({ device, mode }) => device.setChargeMode(mode));

    flow.getActionCard('set_max_current')
      .registerRunListener(({ device, current }) => device.setTargetCurrent(current));

    flow.getActionCard('set_phase_mode')
      .registerRunListener(({ device, mode }) => device.setPhaseMode(mode));

    flow.getActionCard('update_grid_power')
      .registerRunListener(({ device, power }) => device.updateGrid({ power }));

    flow.getActionCard('update_grid_measurement')
      .registerRunListener(({ device, power, l1, l2, l3 }) => device.updateGrid({ power, currents: [l1, l2, l3] }));
  }

}

module.exports = ChargerApp;
