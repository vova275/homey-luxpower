'use strict';

const net = require('net');
const { EventEmitter } = require('events');

const { buildRead, buildWrite, FN_READ_HOLD, FN_READ_INPUT, FN_WRITE_SINGLE } = require('./LxpRequest');
const { LxpResponse } = require('./LxpResponse');

const DEFAULT_PORT = 8000;
const CONNECT_TIMEOUT = 10000;
const READ_TIMEOUT = 5000;
const WRITE_TIMEOUT = 7000;
const IDLE_TIMEOUT = 60000;
const MAX_PACKET_LENGTH = 4096;
const PREFIX = Buffer.from([0xa1, 0x1a]);

/**
 * Local LXP client for a LuxPower Wi-Fi dongle.
 *
 * The dongle multiplexes its own cloud traffic onto the same socket, so reads
 * are framed off the stream (prefix + declared length) and packets that are not
 * the answer to the outstanding request get dropped rather than mistaken for it.
 * Requests are serialised: the protocol carries no transaction id to match on.
 */
class LxpClient extends EventEmitter {

  constructor({ host, port = DEFAULT_PORT, dongleSerial, inverterSerial, logger = null }) {
    super();
    if (!host) throw new Error('host is required');
    if (!dongleSerial) throw new Error('dongleSerial is required');
    if (!inverterSerial) throw new Error('inverterSerial is required');

    this.host = host;
    this.port = port;
    this.dongleSerial = dongleSerial;
    this.inverterSerial = inverterSerial;

    this._log = logger || (() => {});
    this._socket = null;
    this._buffer = Buffer.alloc(0);
    this._pending = null;
    this._queue = Promise.resolve();
    this._idleTimer = null;
  }

  async connect() {
    if (this._socket && !this._socket.destroyed) return;

    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setNoDelay(true);

      const fail = (err) => {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(`Cannot connect to ${this.host}:${this.port}: ${err.message}`));
      };
      const timer = setTimeout(() => fail(new Error('timed out')), CONNECT_TIMEOUT);

      socket.once('error', fail);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeListener('error', fail);
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('error', (err) => this._onSocketGone(err));
        socket.on('close', () => this._onSocketGone(new Error('connection closed')));
        this._socket = socket;
        this._buffer = Buffer.alloc(0);
        this._log(`connected to ${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  disconnect() {
    this._clearIdleTimer();
    const socket = this._socket;
    const pending = this._pending;
    this._socket = null;
    this._pending = null;
    this._buffer = Buffer.alloc(0);

    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Client disconnected'));
    }
  }

  _onSocketGone(err) {
    if (!this._socket) return;
    this._log(`socket lost: ${err.message}`);

    const pending = this._pending;
    this._pending = null;
    this._socket = null;
    this._buffer = Buffer.alloc(0);
    this._clearIdleTimer();

    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.emit('disconnected', err);
  }

  _clearIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  /** Drop the socket after a quiet period so a stale dongle session is not reused. */
  _armIdleTimer() {
    this._clearIdleTimer();
    this._idleTimer = setTimeout(() => {
      this._log('idle, closing connection');
      this.disconnect();
    }, IDLE_TIMEOUT);
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);

    for (;;) {
      // Resync: anything ahead of the prefix is the tail of a frame we skipped.
      const start = this._buffer.indexOf(PREFIX);
      if (start === -1) {
        // Keep one byte: the prefix may straddle this chunk and the next.
        if (this._buffer.length > 1) this._buffer = this._buffer.subarray(this._buffer.length - 1);
        return;
      }
      if (start > 0) this._buffer = this._buffer.subarray(start);
      if (this._buffer.length < 6) return;

      const packetLength = this._buffer.readUInt16LE(4) + 6;
      if (packetLength < 8 || packetLength > MAX_PACKET_LENGTH) {
        // Length field is nonsense, so this prefix was data. Look for the next.
        this._buffer = this._buffer.subarray(2);
        continue;
      }
      if (this._buffer.length < packetLength) return;

      const packet = Buffer.from(this._buffer.subarray(0, packetLength));
      this._buffer = this._buffer.subarray(packetLength);
      this._handlePacket(packet);
    }
  }

  _handlePacket(packet) {
    const response = new LxpResponse(packet);

    if (response.isHeartbeat) {
      this.emit('heartbeat', response);
      return;
    }
    if (!this._pending) {
      this.emit('unsolicited', response);
      return;
    }

    const pending = this._pending;

    // A mismatched-but-valid packet belongs to the dongle's own traffic, not to
    // us; dropping it keeps the outstanding request waiting for its real answer.
    if (response.ok && response.deviceFunction !== pending.expectFunction) {
      this._log(`skipping fn=${response.deviceFunction}, awaiting fn=${pending.expectFunction}`);
      return;
    }
    if (response.ok && pending.expectRegister !== null && response.register !== pending.expectRegister) {
      this._log(`skipping reg=${response.register}, awaiting reg=${pending.expectRegister}`);
      return;
    }

    clearTimeout(pending.timer);
    this._pending = null;
    this._armIdleTimer();

    if (response.ok) pending.resolve(response);
    else pending.reject(new Error(response.error));
  }

  /** Serialise every exchange: responses can only be matched by arrival order. */
  _enqueue(task) {
    const run = this._queue.then(task, task);
    this._queue = run.then(() => {}, () => {});
    return run;
  }

  async _exchange(packet, { expectFunction, expectRegister, timeout }) {
    await this.connect();
    this._clearIdleTimer();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending = null;
        // A timed-out exchange leaves our position in the stream unknown.
        this.disconnect();
        reject(new Error(`Timed out after ${timeout}ms waiting for fn=${expectFunction} reg=${expectRegister}`));
      }, timeout);

      this._pending = { expectFunction, expectRegister, resolve, reject, timer };
      this._socket.write(packet, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this._pending = null;
        reject(err);
      });
    });
  }

  /** Read consecutive registers. fn 4 = input (live data), fn 3 = hold (settings). */
  readRegisters(register, count = 1, functionCode = FN_READ_INPUT) {
    return this._enqueue(async () => {
      const packet = buildRead(this.dongleSerial, this.inverterSerial, register, count, functionCode);
      const response = await this._exchange(packet, {
        expectFunction: functionCode,
        expectRegister: register,
        timeout: READ_TIMEOUT,
      });
      return response.registers;
    });
  }

  /** Write one holding register. Returns the value the inverter echoed back. */
  writeRegister(register, value) {
    return this._enqueue(async () => {
      const packet = buildWrite(this.dongleSerial, this.inverterSerial, register, value);
      const response = await this._exchange(packet, {
        expectFunction: FN_WRITE_SINGLE,
        expectRegister: register,
        timeout: WRITE_TIMEOUT,
      });
      const echoed = response.value.length >= 2 ? response.value.readUInt16LE(0) : null;
      if (echoed !== (value & 0xffff)) {
        throw new Error(`Write to register ${register} not confirmed: sent ${value}, inverter echoed ${echoed}`);
      }
      return echoed;
    });
  }

  /**
   * Sweep a register range in blocks. A failed block is recorded and skipped
   * rather than aborting the sweep: one bad block should not cost a whole poll.
   */
  async readRange({ functionCode = FN_READ_INPUT, start = 0, total = 750, blockSize = 125 } = {}) {
    const registers = {};
    const failures = [];

    for (let reg = start; reg < start + total; reg += blockSize) {
      const count = Math.min(blockSize, start + total - reg);
      try {
        Object.assign(registers, await this.readRegisters(reg, count, functionCode));
      } catch (err) {
        failures.push({ register: reg, count, error: err.message });
        this._log(`block ${reg}-${reg + count - 1} failed: ${err.message}`);
      }
    }
    return { registers, failures };
  }

}

module.exports = { LxpClient, DEFAULT_PORT, FN_READ_HOLD, FN_READ_INPUT };
