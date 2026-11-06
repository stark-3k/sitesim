'use strict'

const { allocateFleet, specFor } = require('./engine/models')

// Every number here is a simulation default, not market or vendor data.
// Override any of them with a JSON file: `sitesim --config my-site.json`.
const DEFAULTS = {
  seed: 1337,
  startHour: 8,
  host: '127.0.0.1',
  ports: {
    api: 8080,
    minerBase: 14030,
    meter: 15020,
    sensorBase: 15021,
    pool: 18000
  },
  fleet: {
    containers: 2,
    minersPerContainer: 60,
    // Relative weights per model, such as { "antminer": 3, "avalon": 1 }.
    // null means an equal share of every model in src/engine/models.js.
    mix: null
  },
  // Physics shared by every model. Hashrate and power are per model.
  miner: {
    sleepW: 35,
    bootW: 120,
    fanMaxW: 160,
    bootSec: [70, 140],
    thermalTauSec: 120,
    hashTauSec: 45,
    throttleC: 85,
    errorC: 92,
    tripC: 100,
    recoverC: 65,
    // Thermal resistance in C/W: full airflow, plus the penalty at zero airflow.
    rBase: 0.012,
    rAirflowPenalty: 0.02,
    modes: {
      0: { name: 'normal', hash: 1, power: 1 },
      1: { name: 'high', hash: 1.06, power: 1.15 },
      2: { name: 'eco', hash: 0.8, power: 0.65 }
    }
  },
  cooling: {
    capacityFactor: 1.15,
    approachC: 3,
    loadRiseC: 5,
    overloadRiseC: 40,
    maxOverload: 1.2,
    tauSec: 300,
    powerFraction: 0.04,
    baseKw: 3,
    derateAboveC: 35,
    deratePerC: 0.02
  },
  grid: {
    // null derives these from the fleet size.
    contractKw: null,
    breakerKw: null,
    breakerTripSec: 60,
    voltageV: 31200,
    powerFactor: 0.98,
    penaltyUsdKwh: 0.25
  },
  environment: {
    ambientMeanC: 24,
    ambientSwingC: 7,
    ambientPeakHour: 15,
    priceOffPeak: 0.035,
    priceShoulder: 0.05,
    pricePeak: 0.085,
    peakHours: [17, 21],
    offPeakHours: [0, 6],
    btcUsd: 100000,
    btcPerThDay: 5e-7
  },
  pools: {
    feeRate: 0.02,
    baseStaleRate: 0.002,
    baseRejectRate: 0.001,
    shareDifficulty: 131072,
    // The first pool also serves the F2Pool API that MDK's Worker polls.
    primary: {
      id: 'f2pool',
      name: 'F2Pool',
      hosts: ['btc.f2pool.com', 'btc-asia.f2pool.com', 'btc-euro.f2pool.com'],
      url: 'stratum+tcp://btc.f2pool.com:1314',
      username: 'haven7346',
      apiSecret: 'secret-key'
    },
    backup: {
      id: 'backup',
      name: 'Backup pool',
      hosts: ['backup.pool.sim'],
      url: 'stratum+tcp://backup.pool.sim:3333',
      username: 'haven7346'
    }
  },
  chaos: {
    enabled: false,
    faultsPerMinerDay: 0.02,
    repairHours: [2, 8]
  },
  history: {
    sampleSec: 15,
    maxSamples: 40320
  }
}

function mergeDeep (base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch || {})) {
    const isObject = value && typeof value === 'object' && !Array.isArray(value)
    out[key] = isObject && base[key] && typeof base[key] === 'object'
      ? mergeDeep(base[key], value)
      : value
  }
  return out
}

function buildConfig (overrides) {
  // The merge shares any section the overrides leave out, and the derived limits
  // below write into the result, so it must not start from DEFAULTS itself.
  const cfg = mergeDeep(structuredClone(DEFAULTS), overrides)
  const count = cfg.fleet.containers * cfg.fleet.minersPerContainer
  if (!Number.isInteger(count) || count < 1) throw new Error('ERR_FLEET_SIZE_INVALID')
  if (count > 2000) throw new Error('ERR_FLEET_TOO_LARGE: the limit is 2000 miners')
  if (cfg.ports.minerBase + count > cfg.ports.meter && cfg.ports.minerBase < cfg.ports.meter) {
    throw new Error('ERR_PORT_OVERLAP: the miner port range runs into ports.meter')
  }

  // Nominal draw: mining power, typical fan load, and cooling.
  const models = allocateFleet(cfg.fleet.mix, count)
  const itKw = models.reduce((sum, id) => sum + specFor(id, cfg.miner).nominalW + cfg.miner.fanMaxW * 0.6, 0) / 1000
  const nominalKw = itKw * (1 + cfg.cooling.powerFraction) + cfg.fleet.containers * cfg.cooling.baseKw
  cfg.grid.contractKw = cfg.grid.contractKw ?? Math.ceil(nominalKw * 1.05)
  cfg.grid.breakerKw = cfg.grid.breakerKw ?? Math.ceil(cfg.grid.contractKw * 1.25)
  cfg.fleet.models = models
  cfg.source = structuredClone(overrides || {})
  return cfg
}

module.exports = { DEFAULTS, buildConfig, mergeDeep }
