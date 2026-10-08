'use strict';

/**
 * Connects to a real LuxPower dongle, sweeps its registers and prints what it
 * found. Run this before touching Homey: it proves the protocol works on your
 * hardware and produces the register dump the driver is built against.
 *
 *   node tools/probe.js --host 192.168.1.50 --dongle BA12345678 --inverter 1234567890
 *
 * Options:
 *   --port <n>       dongle TCP port (default 8000)
 *   --block <n>      registers per request, 125 or 40 for older dongles (default 125)
 *   --total <n>      registers to sweep (default 750)
 *   --out <file>     also write the raw dump as JSON
 *   --verbose        log every exchange
 */

const fs = require('fs');
const path = require('path');

const { LxpClient, FN_READ_HOLD, FN_READ_INPUT } = require('../lib/LxpClient');
const { decodeInput, decodeModel } = require('../lib/registers');

function parseArgs(argv) {
  const args = { port: 8000, block: 125, total: 750, verbose: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--verbose') { args.verbose = true; continue; }
    const value = argv[++i];
    switch (arg) {
      case '--host': args.host = value; break;
      case '--dongle': args.dongle = value; break;
      case '--inverter': args.inverter = value; break;
      case '--port': args.port = Number(value); break;
      case '--block': args.block = Number(value); break;
      case '--total': args.total = Number(value); break;
      case '--out': args.out = value; break;
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }
  for (const required of ['host', 'dongle', 'inverter']) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

function printTable(title, rows) {
  if (!rows.length) return;
  console.log(`\n${title}`);
  console.log('─'.repeat(52));
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [key, value] of rows) {
    console.log(`  ${key.padEnd(width)}  ${value}`);
  }
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const client = new LxpClient({
    host: args.host,
    port: args.port,
    dongleSerial: args.dongle,
    inverterSerial: args.inverter,
    logger: args.verbose ? (msg) => console.log(`  [lxp] ${msg}`) : null,
  });

  let heartbeats = 0;
  client.on('heartbeat', () => { heartbeats++; });

  console.log(`Probing ${args.host}:${args.port} (dongle ${args.dongle}, inverter ${args.inverter})`);
  const startedAt = Date.now();

  try {
    await client.connect();
    console.log('Connected.');

    console.log(`\nReading HOLD registers (fn 3) 0-${args.total - 1} in blocks of ${args.block}...`);
    const hold = await client.readRange({
      functionCode: FN_READ_HOLD, total: args.total, blockSize: args.block,
    });
    console.log(`  ${Object.keys(hold.registers).length} registers, ${hold.failures.length} failed blocks`);

    console.log(`\nReading INPUT registers (fn 4) 0-${args.total - 1}...`);
    const input = await client.readRange({
      functionCode: FN_READ_INPUT, total: args.total, blockSize: args.block,
    });
    console.log(`  ${Object.keys(input.registers).length} registers, ${input.failures.length} failed blocks`);

    for (const failure of [...hold.failures, ...input.failures]) {
      console.log(`  ! block ${failure.register}-${failure.register + failure.count - 1}: ${failure.error}`);
    }

    const model = decodeModel(hold.registers);
    const values = decodeInput(input.registers);

    printTable('Identity', [
      ['model', model || '(not reported)'],
      ['state', values.inverter_state ?? '?'],
      ['fault_code', values.fault_code ?? 0],
      ['warning_code', values.warning_code ?? 0],
    ]);

    const group = (prefixes) => Object.entries(values)
      .filter(([k]) => prefixes.some((p) => k.startsWith(p)))
      .map(([k, v]) => [k, String(v)]);

    printTable('PV', group(['pv']));
    printTable('Battery', group(['battery_', 'cell_']));
    printTable('Grid', group(['grid_', 'power_factor']));
    printTable('Load / inverter', group(['load_', 'inverter_power', 'rectifier_', 'eps_', 'generator_']));
    printTable('Temperatures', group(['temperature_']));
    printTable('Counters', group(['running_time']));

    if (args.out) {
      const file = path.resolve(args.out);
      fs.writeFileSync(file, JSON.stringify({
        probedAt: new Date().toISOString(),
        host: args.host, port: args.port,
        dongleSerial: args.dongle, inverterSerial: args.inverter,
        model,
        blockSize: args.block,
        holdRegisters: hold.registers,
        inputRegisters: input.registers,
        failures: [...hold.failures, ...input.failures],
        decoded: values,
      }, null, 2));
      console.log(`\nRaw dump written to ${file}`);
    }

    console.log(`\nDone in ${((Date.now() - startedAt) / 1000).toFixed(1)}s, ${heartbeats} dongle heartbeats seen.`);
  } catch (err) {
    console.error(`\nFAILED: ${err.message}`);
    console.error('\nChecklist: dongle reachable on the LAN, port 8000 open, serials exactly as printed');
    console.error('on the labels (dongle serial is usually 10 chars starting with BA/BC).');
    process.exitCode = 1;
  } finally {
    client.disconnect();
  }
})();
