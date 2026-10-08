'use strict';

const { crc16Modbus } = require('./crc');
const { PREFIX, TRANSLATED_DATA } = require('./LxpRequest');

/** Smallest meaningful translated-data response: header + data frame + CRC. */
const RESPONSE_OVERHEAD = 37;
const TCP_FN_HEARTBEAT = 193;

const MODBUS_EXCEPTIONS = {
  1: 'Illegal function',
  2: 'Illegal data address',
  3: 'Illegal data value',
  4: 'Slave device failure',
  5: 'Acknowledge',
  6: 'Slave device busy',
  8: 'Memory parity error',
};

/**
 * Parse one complete LXP packet.
 *
 * Fields mirror the wire layout: a 20-byte header (prefix, protocol, frame
 * length, reserved, tcp function, dongle serial, data length), then a data
 * frame, then a CRC over that frame.
 */
class LxpResponse {
  constructor(packet) {
    this.error = null;
    this.exception = 0;
    this.protocolNumber = -1;
    this.tcpFunction = -1;
    this.deviceFunction = -1;
    this.register = -1;
    this.frameLength = -1;
    this.dataLength = -1;
    this.packetLength = -1;
    this.dongleSerial = null;
    this.inverterSerial = null;
    this.value = Buffer.alloc(0);

    if (packet.length < 8) {
      this.error = 'Packet too small';
      return;
    }
    if (!packet.subarray(0, 2).equals(PREFIX)) {
      this.error = 'Missing A11A header';
      return;
    }

    this.protocolNumber = packet.readUInt16LE(2);
    this.frameLength = packet.readUInt16LE(4);
    this.packetLength = this.frameLength + 6;

    if (packet.length < this.packetLength) {
      this.error = `Short packet: expected ${this.packetLength}, got ${packet.length}`;
      return;
    }

    this.tcpFunction = packet[7];

    if (this.tcpFunction === TRANSLATED_DATA) {
      if (packet.length < RESPONSE_OVERHEAD) {
        this.error = 'Translated-data packet too small';
        return;
      }
      this.dongleSerial = packet.subarray(8, 18).toString('ascii').trim();
      this.dataLength = packet.readUInt16LE(18);

      if (!this._takeDataFrame(packet, 20)) return;

      this.addressAction = this.dataFrame[0];
      this.deviceFunction = this.dataFrame[1];
      this.inverterSerial = this.dataFrame.subarray(2, 12).toString('ascii').trim();
      this.register = this.dataFrame.readUInt16LE(12);

      // Protocols 2 and 5 prefix the payload with its own length byte; a
      // function code with the high bit set is a Modbus exception instead.
      const hasLengthByte =
        (this.protocolNumber === 2 || this.protocolNumber === 5) &&
        this.deviceFunction !== 6 &&
        this.deviceFunction < 0x80;

      if (hasLengthByte) {
        const len = this.dataFrame[14];
        this.value = this.dataFrame.subarray(15, 15 + len);
      } else if (this.deviceFunction >= 0x80) {
        this.exception = this.dataFrame[14];
        this.error = `Modbus exception ${this.exception}: ${MODBUS_EXCEPTIONS[this.exception] || 'unknown'}`;
      } else {
        this.value = this.dataFrame.subarray(14, 16);
      }
      return;
    }

    if (this.tcpFunction === TCP_FN_HEARTBEAT) {
      // Dongle<->cloud chatter that arrives on the same socket. Not an error,
      // just not ours: surface it so the client can skip it and keep reading.
      if (packet.length < 19) {
        this.error = 'Heartbeat packet too small';
        return;
      }
      this.dongleSerial = packet.subarray(8, 18).toString('ascii').trim();
      this.value = packet.subarray(18, this.packetLength);
      this.isHeartbeat = true;
      return;
    }

    this.error = `Unsupported tcp_function=${this.tcpFunction}`;
  }

  _takeDataFrame(packet, start) {
    const end = this.packetLength - 2;
    this.dataFrame = packet.subarray(start, end);
    this.crcReceived = packet.readUInt16LE(end);
    const crcCalculated = crc16Modbus(this.dataFrame);
    if (crcCalculated !== this.crcReceived) {
      this.error = `CRC mismatch: calculated ${crcCalculated.toString(16).padStart(4, '0')}, received ${this.crcReceived.toString(16).padStart(4, '0')}`;
      return false;
    }
    return true;
  }

  get ok() {
    return this.error === null;
  }

  /** Register address -> 16-bit little-endian word. */
  get registers() {
    const out = {};
    if (this.exception || this.value.length % 2 !== 0) return out;
    for (let i = 0; i < this.value.length / 2; i++) {
      out[this.register + i] = this.value.readUInt16LE(i * 2);
    }
    return out;
  }

  get info() {
    const regs = Object.keys(this.registers).length;
    return [
      this.error ? `ERR(${this.error})` : 'OK',
      `protocol=${this.protocolNumber}`,
      `tcp_fn=${this.tcpFunction}`,
      `fn=${this.deviceFunction}`,
      `len=${this.packetLength}`,
      regs ? `regs=${this.register}-${this.register + regs - 1}` : `reg=${this.register}`,
    ].join(' ');
  }
}

module.exports = { LxpResponse, RESPONSE_OVERHEAD, TCP_FN_HEARTBEAT, MODBUS_EXCEPTIONS };
