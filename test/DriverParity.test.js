'use strict';

// Both drivers (Vestel EVC04 and Webasto Unite) must stay identical apart from name and icon.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('EVC04 and Unite share settings and pairing screen', () => {
  assert.strictEqual(read('drivers/unite/driver.settings.compose.json'), read('drivers/evc04/driver.settings.compose.json'));
  assert.strictEqual(read('drivers/unite/pair/configure.html'), read('drivers/evc04/pair/configure.html'));
});
