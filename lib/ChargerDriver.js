'use strict';

const Homey = require('homey');
const { VestelClient } = require('./VestelClient');

const PRODUCT_NAMES = {
  evc04: 'Vestel EVC04',
  unite: 'Webasto Unite',
};

class ChargerDriver extends Homey.Driver {

  async onInit() {
    this.log(`${this.productName} driver initialised`);
  }

  /** Product name shown to the user, e.g. "Vestel EVC04" or "Webasto Unite". */
  get productName() {
    return PRODUCT_NAMES[this.id] || 'Vestel EVC04';
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
        name: this.homey.__('pair.device_name', { product: this.productName }),
        data: { id },
        settings: {
          host: host.trim(),
          port: Number(port) || 502,
          unitId: Number(unitId) || 255,
          serial: info.serial || '',
          firmware: info.firmware || '',
          phases: info.threePhase === false ? '1' : '3',
          maxCurrent: info.evseMaxCurrent >= 6 && info.evseMaxCurrent <= 32 ? info.evseMaxCurrent : 16,
          evseMaxCurrent: info.evseMaxCurrent ? `${info.evseMaxCurrent} A` : '',
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

module.exports = ChargerDriver;
