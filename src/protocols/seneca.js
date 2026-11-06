'use strict'

const ModbusServer = require('./modbus')

// Seneca Z-4RTD-2: four channels at driver registers 3-6 (wire addresses 2-5),
// in tenths of a degree. 8500 is the 850.0 reading the driver treats as an error.
const SENSOR_ERROR_RAW = 8500
const FIRST_WIRE_ADDRESS = 2

const CHANNELS = ['inlet', 'exhaust', 'ambient', 'hottest chip']

function channelValues (sim, container) {
  const hottest = container.miners.reduce((max, miner) => Math.max(max, miner.chipC), -100)
  return [container.inletC, container.exhaustC, sim.env.ambientC, hottest]
}

function readChannel (sim, container, address) {
  const channel = address - FIRST_WIRE_ADDRESS
  if (channel < 0 || channel >= CHANNELS.length) return null
  if (container.fx.sensorFault) return SENSOR_ERROR_RAW
  return Math.max(0, Math.round(channelValues(sim, container)[channel] * 10))
}

function createSenecaServers (getSim, stats) {
  const sim = getSim()
  return sim.containers.map((container, index) => new ModbusServer({
    port: container.sensorPort,
    host: sim.cfg.host,
    onRequest: () => stats.record('seneca', container.id),
    readRegister: (address) => {
      const current = getSim()
      return readChannel(current, current.containers[index], address)
    }
  }))
}

module.exports = { createSenecaServers, readChannel, CHANNELS, SENSOR_ERROR_RAW }
