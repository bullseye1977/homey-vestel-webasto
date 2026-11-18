'use strict';

const Homey = require('homey');
const { VestelClient } = require('../../lib/VestelClient');

class Evc04Driver extends Homey.Driver {

  async onInit() {
    this._registerFlowCards();
    this.log('Vestel EVC04 driver initialised');
  }

  _registerFlowCards() {
    this.homey.flow.getConditionCard('is_car_connected')
      .registerRunListener(({ device }) => device.getCapabilityValue('evcharger_charging_state') !== 'plugged_out');

    this.homey.flow.getConditionCard('charge_mode_is')
      .registerRunListener(({ device, mode }) => device.getCapabilityValue('vestel_charge_mode') === mode);

    this.homey.flow.getActionCard('set_charge_mode')
      .registerRunListener(({ device, mode }) => device.setChargeMode(mode));

    this.homey.flow.getActionCard('set_max_current')
      .registerRunListener(({ device, current }) => device.setTargetCurrent(current));

    this.homey.flow.getActionCard('update_grid_power')
      .registerRunListener(({ device, power }) => device.updateGrid({ power }));

    this.homey.flow.getActionCard('update_grid_measurement')
      .registerRunListener(({ device, power, l1, l2, l3 }) => device.updateGrid({ power, currents: [l1, l2, l3] }));
  }

  /** Try to reach the charger and return a device object for Homey.createDevice(). */
  async _probe({ host, port, unitId }) {
    if (!host || typeof host !== 'string') throw new Error(this.homey.__('pair.no_host'));
    const client = new VestelClient({ host: host.trim(), port, unitId, log: (...a) => this.log(...a) });
    try {
      const info = await client.readInfo();
      await client.readStatus(); // proves the main registers answer
      return info;
    } catch (err) {
      this.error('Probe failed', err);
      throw new Error(this.homey.__('pair.connect_failed', { error: err.message }));
    } finally {
      await client.close();
    }
  }

  async onPair(session) {
    session.setHandler('get_current', async () => null);
    session.setHandler('connect', async ({ host, port, unitId }) => {
      this.log(`Pairing: probing ${host}:${port} (unit ${unitId})`);
      const info = await this._probe({ host, port, unitId });
      this.log('Pairing: charger found', info);
      const id = info.serial || `${host.trim()}:${port}`;
      return {
        name: info.model ? `Laadpaal ${info.brand || 'Vestel'} ${info.model}`.trim() : 'Laadpaal Vestel EVC04',
        data: { id },
        settings: {
          host: host.trim(),
          port: Number(port) || 502,
          unitId: Number(unitId) || 255,
          serial: info.serial || '',
          firmware: info.firmware || '',
          phases: info.threePhase === false ? '1' : '3',
        },
      };
    });
  }

  async onRepair(session, device) {
    session.setHandler('get_current', async () => device.getSettings());
    session.setHandler('connect', async ({ host, port, unitId }) => {
      await this._probe({ host, port, unitId });
      await device.setSettings({ host: host.trim(), port: Number(port) || 502, unitId: Number(unitId) || 255 });
      await device.reconnect();
      return { repaired: true };
    });
  }

}

module.exports = Evc04Driver;
