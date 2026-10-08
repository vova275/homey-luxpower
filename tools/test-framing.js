'use strict';

/**
 * Exercises LxpClient against a fake dongle that reproduces the awkward parts of
 * the real one: responses split across TCP chunks, two frames coalesced into one
 * chunk, and unsolicited cloud heartbeats interleaved with our answers.
 *
 * Run: node tools/test-framing.js
 */

const net = require('net');
const assert = require('assert');

const { crc16Modbus } = require('../lib/crc');
const { serialToBuffer } = require('../lib/LxpRequest');
const { LxpClient } = require('../lib/LxpClient');

const DONGLE = 'BA12345678';
const INVERTER = '1234567890';

/** Build a protocol-2 translated-data response carrying `values` from `register`. */
function buildResponse({ protocol = 2, functionCode, register, values }) {
  const payload = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => payload.writeUInt16LE(v & 0xffff, i * 2));

  const dataFrame = Buffer.concat([
    Buffer.from([0x00, functionCode]),
    serialToBuffer(INVERTER, 'inverter'),
    (() => { const b = Buffer.alloc(2); b.writeUInt16LE(register); return b; })(),
    Buffer.from([payload.length]),
    payload,
  ]);

  const header = Buffer.alloc(20);
  header.writeUInt8(0xa1, 0); header.writeUInt8(0x1a, 1);
  header.writeUInt16LE(protocol, 2);
  header.writeUInt16LE(dataFrame.length + 2 + 14, 4); // frame length = packet length - 6
  header.writeUInt8(1, 6);
  header.writeUInt8(194, 7);
  serialToBuffer(DONGLE, 'dongle').copy(header, 8);
  header.writeUInt16LE(dataFrame.length + 2, 18);

  const crc = Buffer.alloc(2);
  crc.writeUInt16LE(crc16Modbus(dataFrame));
  return Buffer.concat([header, dataFrame, crc]);
}

/** Write-single ack: protocol 1, no length byte, echoes the written value. */
function buildWriteAck({ register, value }) {
  const dataFrame = Buffer.concat([
    Buffer.from([0x00, 0x06]),
    serialToBuffer(INVERTER, 'inverter'),
    (() => { const b = Buffer.alloc(2); b.writeUInt16LE(register); return b; })(),
    (() => { const b = Buffer.alloc(2); b.writeUInt16LE(value & 0xffff); return b; })(),
  ]);

  const header = Buffer.alloc(20);
  header.writeUInt8(0xa1, 0); header.writeUInt8(0x1a, 1);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(dataFrame.length + 2 + 14, 4);
  header.writeUInt8(1, 6);
  header.writeUInt8(194, 7);
  serialToBuffer(DONGLE, 'dongle').copy(header, 8);
  header.writeUInt16LE(dataFrame.length + 2, 18);

  const crc = Buffer.alloc(2);
  crc.writeUInt16LE(crc16Modbus(dataFrame));
  return Buffer.concat([header, dataFrame, crc]);
}

/** Cloud heartbeat (tcp function 193) that the dongle emits on its own. */
function buildHeartbeat() {
  const body = Buffer.from([0x00]);
  const packet = Buffer.alloc(19);
  packet.writeUInt8(0xa1, 0); packet.writeUInt8(0x1a, 1);
  packet.writeUInt16LE(2, 2);
  packet.writeUInt16LE(13, 4); // 19 - 6
  packet.writeUInt8(1, 6);
  packet.writeUInt8(193, 7);
  serialToBuffer(DONGLE, 'dongle').copy(packet, 8);
  body.copy(packet, 18);
  return packet;
}

function startFakeDongle() {
  const requests = [];
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      const register = chunk.readUInt16LE(32);
      const functionCode = chunk[21];
      const payload = chunk.readUInt16LE(34);
      requests.push({ functionCode, register, payload });

      if (functionCode === 6) {
        socket.write(buildWriteAck({ register, value: payload }));
        return;
      }

      const values = Array.from({ length: payload }, (_, i) => register + i);
      const response = buildResponse({ functionCode, register, values });

      // Heartbeat first, then the answer split mid-frame across two writes:
      // both must be handled without losing the answer.
      socket.write(Buffer.concat([buildHeartbeat(), response.subarray(0, 25)]));
      setImmediate(() => socket.write(response.subarray(25)));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

(async () => {
  const { server, port, requests } = await startFakeDongle();
  const heartbeats = [];
  const client = new LxpClient({
    host: '127.0.0.1',
    port,
    dongleSerial: DONGLE,
    inverterSerial: INVERTER,
  });
  client.on('heartbeat', (r) => heartbeats.push(r));

  try {
    const block = await client.readRegisters(0, 40, 4);
    assert.strictEqual(Object.keys(block).length, 40, 'should decode 40 registers');
    assert.strictEqual(block[0], 0);
    assert.strictEqual(block[39], 39);
    console.log('✓ split-frame read of 40 input registers');

    const hold = await client.readRegisters(125, 125, 3);
    assert.strictEqual(Object.keys(hold).length, 125);
    assert.strictEqual(hold[125], 125);
    assert.strictEqual(hold[249], 249);
    console.log('✓ 125-register hold block');

    const sweep = await client.readRange({ functionCode: 4, total: 750, blockSize: 125 });
    assert.strictEqual(sweep.failures.length, 0, 'sweep should not fail');
    assert.strictEqual(Object.keys(sweep.registers).length, 750);
    console.log('✓ full 750-register sweep in 6 blocks');

    const echoed = await client.writeRegister(21, 0x1234);
    assert.strictEqual(echoed, 0x1234);
    console.log('✓ write ack verified by echo');

    const parallel = await Promise.all([
      client.readRegisters(0, 2, 4),
      client.readRegisters(10, 2, 4),
      client.readRegisters(20, 2, 4),
    ]);
    assert.deepStrictEqual(parallel.map((r) => Object.keys(r)[0]), ['0', '10', '20']);
    console.log('✓ concurrent calls serialised, answers not crossed');

    assert.ok(heartbeats.length > 0, 'heartbeats should be surfaced, not parsed as answers');
    console.log(`✓ ${heartbeats.length} heartbeats skipped cleanly`);
    console.log(`\n${requests.length} requests served. All framing tests passed.`);
  } finally {
    client.disconnect();
    server.close();
  }
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
