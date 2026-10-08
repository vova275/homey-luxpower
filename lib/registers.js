'use strict';

/**
 * Register map for LuxPower inverters, ported from the LXP Modbus RTU protocol
 * tables used by ant0nkr/luxpower-ha-integration (MIT).
 *
 * Input registers (function 4) are live measurements; hold registers
 * (function 3/6) are settings. Only the values a Homey device actually surfaces
 * are listed here — the protocol exposes ~750 registers, most of them
 * diagnostics that belong in a settings page rather than in a capability.
 */

const INPUT = {
  STATE: 0,
  VPV1: 1, VPV2: 2, VPV3: 3,
  VBAT: 4,
  SOC_SOH: 5,
  INTERNAL_FAULT: 6,
  PPV1: 7, PPV2: 8, PPV3: 9,
  PCHARGE: 10, PDISCHARGE: 11,
  VAC_R: 12, VAC_S: 13, VAC_T: 14,
  FAC: 15,
  PINV: 16, PREC: 17,
  IINV_RMS: 18, PF: 19,
  VEPS_R: 20, FEPS: 23, PEPS: 24, SEPS: 25,
  PTOGRID: 26, PTOUSER: 27,
  EPV1_DAY: 28, EPV2_DAY: 29, EPV3_DAY: 30,
  EINV_DAY: 31, EREC_DAY: 32,
  ECHG_DAY: 33, EDISCHG_DAY: 34,
  EEPS_DAY: 35, ETOGRID_DAY: 36, ETOUSER_DAY: 37,
  VBUS1: 38, VBUS2: 39,
  EPV1_ALL: 40, EPV2_ALL: 42, EPV3_ALL: 44,
  EINV_ALL: 46, EREC_ALL: 48,
  ECHG_ALL: 50, EDISCHG_ALL: 52,
  EEPS_ALL: 54, ETOGRID_ALL: 56, ETOUSER_ALL: 58,
  FAULT_CODE: 60, WARNING_CODE: 62,
  TINNER: 64, TRADIATOR1: 65, TRADIATOR2: 66, TBAT: 67,
  RUNNING_TIME: 69,
  BMS_MAX_CHG_CURR: 81, BMS_MAX_DISCHG_CURR: 82,
  BAT_PARALLEL_NUM: 96, BAT_CAPACITY: 97,
  BMS_BAT_CURRENT: 98,
  BMS_MAX_CELL_VOLT: 101, BMS_MIN_CELL_VOLT: 102,
  BMS_MAX_CELL_TEMP: 103, BMS_MIN_CELL_TEMP: 104,
  BMS_CYCLE_COUNT: 106,
  GEN_POWER: 123, EGEN_DAY: 124, EGEN_ALL: 125,
  PLOAD: 170, ELOAD_DAY: 171, ELOAD_ALL: 172,
};

const HOLD = {
  MODEL: 7, // + 8: four ASCII chars across two registers
  SERIAL_START: 115,
};

/** Inverter operating state, register 0. */
const INVERTER_STATES = {
  0: 'Standby',
  1: 'Fault',
  2: 'Programming / Updating',
  4: 'PV powering load, exporting surplus',
  8: 'PV powering load and charging battery',
  12: 'PV powering load, charging battery, exporting',
  16: 'Battery discharging to load, exporting surplus',
  17: 'Standby',
  20: 'PV and battery powering load, exporting surplus',
  32: 'Grid charging battery',
  40: 'Grid and PV charging battery',
  64: 'Off-grid: battery powering load',
  96: 'Off-grid: AC-coupled PV charging battery',
  128: 'Off-grid: PV power unstable (prohibited)',
  136: 'Off-grid: PV powering load and charging battery',
  192: 'Off-grid: PV and battery powering load',
};

const U16 = 0xffff;
const UNIMPLEMENTED = 0xffff;

const toSigned16 = (value) => (value > 0x7fff ? value - 0x10000 : value);

/** 32-bit counters are stored as a low/high register pair, low first. */
function read32(registers, lowRegister) {
  const low = registers[lowRegister];
  const high = registers[lowRegister + 1];
  if (low === undefined || high === undefined) return null;
  return ((high & U16) * 0x10000) + (low & U16);
}

function read16(registers, register, { signed = false } = {}) {
  const raw = registers[register];
  if (raw === undefined) return null;
  return signed ? toSigned16(raw) : raw;
}

/**
 * Values a Homey device exposes.
 *
 * `scale` converts the raw register to the capability's unit; `signed` marks
 * registers that carry two's-complement values; `wide` marks 32-bit pairs.
 */
const VALUES = [
  // --- PV ---
  { key: 'pv1_voltage', register: INPUT.VPV1, scale: 0.1, unit: 'V' },
  { key: 'pv2_voltage', register: INPUT.VPV2, scale: 0.1, unit: 'V' },
  { key: 'pv3_voltage', register: INPUT.VPV3, scale: 0.1, unit: 'V' },
  { key: 'pv1_power', register: INPUT.PPV1, scale: 1, unit: 'W' },
  { key: 'pv2_power', register: INPUT.PPV2, scale: 1, unit: 'W' },
  { key: 'pv3_power', register: INPUT.PPV3, scale: 1, unit: 'W' },
  { key: 'pv_energy_today', register: INPUT.EPV1_DAY, scale: 0.1, unit: 'kWh' },

  // --- Battery ---
  { key: 'battery_voltage', register: INPUT.VBAT, scale: 0.1, unit: 'V' },
  { key: 'battery_charge_power', register: INPUT.PCHARGE, scale: 1, unit: 'W' },
  { key: 'battery_discharge_power', register: INPUT.PDISCHARGE, scale: 1, unit: 'W' },
  { key: 'battery_current', register: INPUT.BMS_BAT_CURRENT, scale: 0.01, unit: 'A', signed: true },
  { key: 'battery_temperature', register: INPUT.TBAT, scale: 1, unit: '°C', signed: true },
  { key: 'battery_capacity', register: INPUT.BAT_CAPACITY, scale: 1, unit: 'Ah' },
  { key: 'battery_cycles', register: INPUT.BMS_CYCLE_COUNT, scale: 1, unit: '' },
  { key: 'cell_voltage_max', register: INPUT.BMS_MAX_CELL_VOLT, scale: 0.001, unit: 'V' },
  { key: 'cell_voltage_min', register: INPUT.BMS_MIN_CELL_VOLT, scale: 0.001, unit: 'V' },
  { key: 'cell_temp_max', register: INPUT.BMS_MAX_CELL_TEMP, scale: 0.1, unit: '°C', signed: true },
  { key: 'cell_temp_min', register: INPUT.BMS_MIN_CELL_TEMP, scale: 0.1, unit: '°C', signed: true },
  { key: 'battery_charged_today', register: INPUT.ECHG_DAY, scale: 0.1, unit: 'kWh' },
  { key: 'battery_discharged_today', register: INPUT.EDISCHG_DAY, scale: 0.1, unit: 'kWh' },

  // --- Grid ---
  { key: 'grid_voltage', register: INPUT.VAC_R, scale: 0.1, unit: 'V' },
  { key: 'grid_frequency', register: INPUT.FAC, scale: 0.01, unit: 'Hz' },
  { key: 'grid_export_power', register: INPUT.PTOGRID, scale: 1, unit: 'W' },
  { key: 'grid_import_power', register: INPUT.PTOUSER, scale: 1, unit: 'W' },
  { key: 'grid_exported_today', register: INPUT.ETOGRID_DAY, scale: 0.1, unit: 'kWh' },
  { key: 'grid_imported_today', register: INPUT.ETOUSER_DAY, scale: 0.1, unit: 'kWh' },
  { key: 'power_factor', register: INPUT.PF, scale: 0.001, unit: '' },

  // --- Inverter / load ---
  { key: 'inverter_power', register: INPUT.PINV, scale: 1, unit: 'W' },
  { key: 'rectifier_power', register: INPUT.PREC, scale: 1, unit: 'W' },
  { key: 'load_power', register: INPUT.PLOAD, scale: 1, unit: 'W' },
  { key: 'load_energy_today', register: INPUT.ELOAD_DAY, scale: 0.1, unit: 'kWh' },
  { key: 'eps_voltage', register: INPUT.VEPS_R, scale: 0.1, unit: 'V' },
  { key: 'eps_power', register: INPUT.PEPS, scale: 1, unit: 'W' },
  { key: 'generator_power', register: INPUT.GEN_POWER, scale: 1, unit: 'W' },

  // --- Temperatures ---
  { key: 'temperature_inner', register: INPUT.TINNER, scale: 1, unit: '°C', signed: true },
  { key: 'temperature_radiator1', register: INPUT.TRADIATOR1, scale: 1, unit: '°C', signed: true },
  { key: 'temperature_radiator2', register: INPUT.TRADIATOR2, scale: 1, unit: '°C', signed: true },

  // --- Lifetime counters (32-bit pairs) ---
  { key: 'pv_energy_total', register: INPUT.EPV1_ALL, scale: 0.1, unit: 'kWh', wide: true },
  { key: 'battery_charged_total', register: INPUT.ECHG_ALL, scale: 0.1, unit: 'kWh', wide: true },
  { key: 'battery_discharged_total', register: INPUT.EDISCHG_ALL, scale: 0.1, unit: 'kWh', wide: true },
  { key: 'grid_exported_total', register: INPUT.ETOGRID_ALL, scale: 0.1, unit: 'kWh', wide: true },
  { key: 'grid_imported_total', register: INPUT.ETOUSER_ALL, scale: 0.1, unit: 'kWh', wide: true },
  { key: 'load_energy_total', register: INPUT.ELOAD_ALL, scale: 0.1, unit: 'kWh', wide: true },
  { key: 'running_time', register: INPUT.RUNNING_TIME, scale: 1, unit: 's', wide: true },
];

/** Round away float noise introduced by the scale factor. */
function applyScale(raw, scale) {
  const value = raw * scale;
  return scale === 1 ? value : Math.round(value * 1000) / 1000;
}

/**
 * Decode a register dump into named values.
 * Registers the inverter does not implement read back as 0xFFFF and are dropped
 * rather than reported as an absurd measurement.
 */
function decodeInput(registers) {
  const out = {};

  for (const def of VALUES) {
    const raw = def.wide
      ? read32(registers, def.register)
      : read16(registers, def.register, { signed: def.signed });

    if (raw === null) continue;
    if (!def.wide && !def.signed && registers[def.register] === UNIMPLEMENTED) continue;

    out[def.key] = applyScale(raw, def.scale);
  }

  // Register 5 packs SOC in the low byte and SOH in the high byte.
  const socSoh = registers[INPUT.SOC_SOH];
  if (socSoh !== undefined) {
    out.battery_soc = socSoh & 0xff;
    out.battery_soh = (socSoh >> 8) & 0xff;
  }

  const state = registers[INPUT.STATE];
  if (state !== undefined) {
    out.inverter_state_code = state;
    out.inverter_state = INVERTER_STATES[state] || `Unknown (${state})`;
  }

  const faultCode = read32(registers, INPUT.FAULT_CODE);
  if (faultCode !== null) out.fault_code = faultCode;
  const warningCode = read32(registers, INPUT.WARNING_CODE);
  if (warningCode !== null) out.warning_code = warningCode;

  // Total PV is reported per string; register 9 doubles as the total on models
  // with fewer than three strings, so sum the strings we actually read.
  const pv = [out.pv1_power, out.pv2_power, out.pv3_power].filter((v) => typeof v === 'number');
  if (pv.length) out.pv_power_total = pv.reduce((a, b) => a + b, 0);

  // Signed convenience values: one number per flow, positive in the usual direction.
  if (out.battery_charge_power !== undefined && out.battery_discharge_power !== undefined) {
    out.battery_power = out.battery_charge_power - out.battery_discharge_power;
  }
  if (out.grid_import_power !== undefined && out.grid_export_power !== undefined) {
    out.grid_power = out.grid_import_power - out.grid_export_power;
  }

  return out;
}

/** Model name lives in hold registers 7 and 8, two ASCII chars each. */
function decodeModel(holdRegisters) {
  let model = '';
  for (const reg of [HOLD.MODEL, HOLD.MODEL + 1]) {
    const value = holdRegisters[reg] || 0;
    model += String.fromCharCode((value >> 8) & 0xff, value & 0xff);
  }
  return model.replace(/\0/g, '').trim();
}

module.exports = {
  INPUT, HOLD, INVERTER_STATES, VALUES,
  decodeInput, decodeModel, read16, read32, toSigned16,
};
