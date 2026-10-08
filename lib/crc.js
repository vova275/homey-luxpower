'use strict';

/**
 * CRC-16/MODBUS (init 0xFFFF, reversed polynomial 0xA001).
 * The LXP protocol computes it over the inner 16-byte data frame only.
 */
function crc16Modbus(buf) {
  let crc = 0xffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

module.exports = { crc16Modbus };
