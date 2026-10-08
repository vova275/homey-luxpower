'use strict';

const { crc16Modbus } = require('./crc');

const PREFIX = Buffer.from([0xa1, 0x1a]);
const PROTOCOL = 1;
const FRAME_LENGTH = 32;
const DATA_LENGTH = 18;
const TRANSLATED_DATA = 194;

const ACTION_WRITE = 0;
const FN_READ_HOLD = 3;
const FN_READ_INPUT = 4;
const FN_WRITE_SINGLE = 6;

/** Serials travel as fixed 10 ASCII bytes, space-padded if short. */
function serialToBuffer(serial, label) {
  const buf = Buffer.alloc(10, 0x20);
  const written = buf.write(String(serial), 0, 'ascii');
  if (String(serial).length > 10) {
    throw new Error(`${label} must be at most 10 characters, got ${String(serial).length}`);
  }
  if (written === 0) throw new Error(`${label} must not be empty`);
  return buf;
}

/**
 * Build a 38-byte LXP packet: 20-byte header, 16-byte data frame, 2-byte CRC.
 * The CRC covers bytes 20..35 only.
 */
function buildPacket(dongleSerial, inverterSerial, functionCode, register, payload) {
  if (!Number.isInteger(register) || register < 0 || register > 0xffff) {
    throw new Error(`register out of range: ${register}`);
  }
  if (!Number.isInteger(payload) || payload < 0 || payload > 0xffff) {
    throw new Error(`payload out of range: ${payload}`);
  }

  const packet = Buffer.alloc(38);
  let o = 0;
  PREFIX.copy(packet, o); o += 2;
  packet.writeUInt16LE(PROTOCOL, o); o += 2;
  packet.writeUInt16LE(FRAME_LENGTH, o); o += 2;
  packet.writeUInt8(1, o); o += 1;
  packet.writeUInt8(TRANSLATED_DATA, o); o += 1;
  serialToBuffer(dongleSerial, 'dongleSerial').copy(packet, o); o += 10;
  packet.writeUInt16LE(DATA_LENGTH, o); o += 2;

  // data frame (16 bytes, offset 20)
  packet.writeUInt8(ACTION_WRITE, o); o += 1;
  packet.writeUInt8(functionCode, o); o += 1;
  serialToBuffer(inverterSerial, 'inverterSerial').copy(packet, o); o += 10;
  packet.writeUInt16LE(register, o); o += 2;
  packet.writeUInt16LE(payload, o); o += 2;

  packet.writeUInt16LE(crc16Modbus(packet.subarray(20, 36)), 36);
  return packet;
}

const buildRead = (dongleSerial, inverterSerial, register, count = 1, functionCode = FN_READ_INPUT) => {
  if (!Number.isInteger(count) || count < 1 || count > 0xffff) {
    throw new Error(`count out of range: ${count}`);
  }
  return buildPacket(dongleSerial, inverterSerial, functionCode, register, count);
};

const buildWrite = (dongleSerial, inverterSerial, register, value) =>
  buildPacket(dongleSerial, inverterSerial, FN_WRITE_SINGLE, register, value & 0xffff);

module.exports = {
  PREFIX, PROTOCOL, TRANSLATED_DATA,
  FN_READ_HOLD, FN_READ_INPUT, FN_WRITE_SINGLE,
  serialToBuffer, buildRead, buildWrite,
};
