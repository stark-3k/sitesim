'use strict'

const ModbusServer = require('./modbus')

// SATEC PM180 register map, using the scaling in MDK's Satec driver. The driver
// asks for registers 257, 272 and 296; its client sends each address minus one.
const ENG_LO = -108682.56
const POWER_STEP = 217365.12 / 9999
const VOLTS_STEP = 45360 / 9999
const AMPS_STEP = 1198 / 9999

// Rounds halves down, so zero power reads as zero. A register count is worth
// about 21.7 kW, which is a property of the device's scaling.
function encodePower (kw) {
  const raw = Math.ceil((kw - ENG_LO) / POWER_STEP - 0.5)
  return Math.max(0, Math.min(9999, raw))
}

function encodePowerFactor (pf) {
  return Math.round((pf + 1) * 9999 / 2)
}

function registers (sim) {
  const { powerKw, voltageV, powerFactor } = sim.meterReading
  const live = voltageV > 0
  const kw = live ? powerKw : 0
  const kva = kw / powerFactor
  const kvar = Math.sqrt(Math.max(0, kva * kva - kw * kw))
  const amps = live ? (kw * 1000) / (Math.sqrt(3) * voltageV * powerFactor) : 0
  const volts = Math.round(voltageV / VOLTS_STEP)
  const current = Math.round(amps / AMPS_STEP)
  const pf = encodePowerFactor(live ? powerFactor : 1)

  return {
    256: volts,
    257: volts,
    258: volts,
    259: current,
    260: current,
    261: current,
    271: pf,
    272: pf,
    273: pf,
    274: 0,
    275: encodePower(kw),
    276: encodePower(kvar),
    277: encodePower(kva),
    295: 17,
    296: 19,
    297: 16,
    298: 30,
    299: 39,
    300: 38
  }
}

function createSatecServer (getSim, stats) {
  const sim = getSim()
  return new ModbusServer({
    port: sim.cfg.ports.meter,
    host: sim.cfg.host,
    onRequest: () => stats.record('satec', 'meter'),
    readRegister: (address) => registers(getSim())[address] ?? null
  })
}

module.exports = { createSatecServer, registers, encodePower }
