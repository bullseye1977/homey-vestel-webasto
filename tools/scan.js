'use strict';

/*
 * Reads the Modbus registers of a Vestel EVC04 / Webasto Unite one by one and prints them.
 * Used to find out which registers a firmware actually fills.
 *
 *   node tools/scan.js 192.168.2.231
 *
 * Stop the Homey app first: the charger accepts only one Modbus connection.
 */

const ModbusRTU = require('modbus-serial');

const host = process.argv[2];
if (!host) {
  console.log('Usage: node tools/scan.js <ip-address>');
  process.exit(1);
}

const INPUT_RANGES = [
  [1000, 1050],
  [1100, 1110],
  [1500, 1520],
];
const HOLDING_RANGES = [
  [404, 406],
  [2000, 2004],
  [5000, 5006],
  [6000, 6000],
];

async function scan(client, label, fn, ranges) {
  console.log(`\n=== ${label} ===`);
  for (const [from, to] of ranges) {
    const nonZero = [];
    const errors = [];
    for (let addr = from; addr <= to; addr++) {
      try {
        const value = (await fn(addr)).data[0];
        if (value !== 0) nonZero.push(`${addr}=${value}`);
      } catch (err) {
        errors.push(addr);
        if (!client.isOpen) await client.connectTCP(host, { port: 502 });
      }
    }
    console.log(`${from}-${to}: ${nonZero.length ? nonZero.join('  ') : '(all 0)'}`);
    if (errors.length) console.log(`   no answer: ${errors.join(', ')}`);
  }
}

(async () => {
  const client = new ModbusRTU();
  await client.connectTCP(host, { port: 502 });
  client.setID(255);
  client.setTimeout(2000);
  console.log(`Connected to ${host}`);

  await scan(client, 'INPUT registers (FC4)', a => client.readInputRegisters(a, 1), INPUT_RANGES);
  await scan(client, 'HOLDING registers (FC3)', a => client.readHoldingRegisters(a, 1), HOLDING_RANGES);
  // Some firmware only fills the measurement registers as holding registers.
  await scan(client, 'Measurement block as HOLDING (FC3)', a => client.readHoldingRegisters(a, 1), [[1000, 1040], [1500, 1512]]);

  client.close(() => process.exit(0));
})().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
