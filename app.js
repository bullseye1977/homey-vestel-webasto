'use strict';

const Homey = require('homey');

class VestelApp extends Homey.App {

  async onInit() {
    this.log('Vestel EVC04 app started');
  }

}

module.exports = VestelApp;
