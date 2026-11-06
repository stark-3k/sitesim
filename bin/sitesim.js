#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const { parseArgs } = require('util')
const { buildConfig } = require('../src/config')
const Simulation = require('../src/engine/simulation')
const { loadScenarios, parseTime } = require('../src/engine/scenarios')
const { Runner } = require('../src/runner')
const { publicModels } = require('../src/engine/models')
const { createApi, historyCsv } = require('../src/server/api')

const HELP = `sitesim: a mining site simulator that MDK Workers can connect to

Usage
  sitesim [options]              Start the simulator and its control panel
  sitesim --headless ...         Run a batch simulation as fast as possible
  sitesim mdk-config             Print the settings to point MDK's Workers at it

Options
  --port <n>                     Control panel port (default 8080)
  --host <addr>                  Address to bind (default 127.0.0.1)
  --seed <n>                     Random seed; the same seed replays the same site
  --containers <n>               Number of containers (default 2)
  --miners-per-container <n>     Miners in each container (default 60)
  --mix <model=weight,...>       Fleet mix, such as antminer=3,avalon=1 (default: equal)
                                 Models: avalon, antminer, whatsminer, sealminer, luxos, proto
  --speed <n>                    1, 10, 60, 300, 1800 or 3600 (default 1)
  --start-hour <n>               Simulated hour of day at start (default 8)
  --scenario <id>                Scenario to start with
  --config <file>                JSON file overriding any default in src/config.js
  --no-devices                   Skip the device protocol servers

Headless
  --duration <hh:mm:ss>          Simulated time to run (default 24:00:00)
  --out <file>                   Save metrics to a .csv or .json file
  -h, --help                     Show this help
`

function parseCli () {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      seed: { type: 'string' },
      containers: { type: 'string' },
      'miners-per-container': { type: 'string' },
      mix: { type: 'string' },
      speed: { type: 'string' },
      'start-hour': { type: 'string' },
      scenario: { type: 'string' },
      config: { type: 'string' },
      'no-devices': { type: 'boolean' },
      headless: { type: 'boolean' },
      duration: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' }
    }
  })
  return { values, command: positionals[0] }
}

function toNumber (value, name) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`--${name} must be a number`)
  return number
}

function parseMix (text) {
  const mix = {}
  for (const part of text.split(',')) {
    const [model, weight = '1'] = part.split('=')
    mix[model.trim()] = toNumber(weight, 'mix')
  }
  return mix
}

function buildFromCli (values) {
  const overrides = values.config ? JSON.parse(fs.readFileSync(values.config, 'utf8')) : {}
  overrides.fleet = { ...overrides.fleet }
  overrides.ports = { ...overrides.ports }
  if (values.seed !== undefined) overrides.seed = toNumber(values.seed, 'seed')
  if (values['start-hour'] !== undefined) overrides.startHour = toNumber(values['start-hour'], 'start-hour')
  if (values.host !== undefined) overrides.host = values.host
  if (values.port !== undefined) overrides.ports.api = toNumber(values.port, 'port')
  if (values.containers !== undefined) overrides.fleet.containers = toNumber(values.containers, 'containers')
  if (values['miners-per-container'] !== undefined) {
    overrides.fleet.minersPerContainer = toNumber(values['miners-per-container'], 'miners-per-container')
  }
  if (values.mix !== undefined) overrides.fleet.mix = parseMix(values.mix)
  return buildConfig(overrides)
}

function runHeadless (cfg, values) {
  const scenarios = loadScenarios(path.join(__dirname, '..', 'scenarios'))
  const sim = new Simulation(cfg)
  if (values.scenario) {
    const scenario = scenarios.get(values.scenario)
    if (!scenario) throw new Error(`Unknown scenario: ${values.scenario}. Choose from: ${[...scenarios.keys()].join(', ')}`)
    sim.startScenario(scenario)
  }

  const duration = values.duration
    ? parseTime(values.duration)
    : values.scenario ? scenarios.get(values.scenario).durationSec : 86400

  const started = Date.now()
  for (let i = 0; i < duration; i++) sim.step(1)
  const scenarioResult = sim.lastScenarioResult

  const { economics: eco, site } = sim
  console.log(JSON.stringify({
    simulatedHours: +(duration / 3600).toFixed(2),
    wallSeconds: +((Date.now() - started) / 1000).toFixed(2),
    seed: cfg.seed,
    miners: sim.miners.length,
    energyKwh: +eco.energyKwh.toFixed(1),
    btcEarned: +eco.btcEarned.toFixed(6),
    revenueUsd: +eco.revenueUsd.toFixed(2),
    powerCostUsd: +eco.powerCostUsd.toFixed(2),
    penaltyUsd: +eco.penaltyUsd.toFixed(2),
    profitUsd: +(eco.revenueUsd - eco.powerCostUsd - eco.penaltyUsd).toFixed(2),
    final: {
      hashThs: +site.hashThs.toFixed(0),
      powerKw: +site.powerKw.toFixed(1),
      maxChipC: +site.maxChipC.toFixed(1),
      counts: sim.fleetCounts()
    },
    scenario: scenarioResult
  }, null, 2))

  if (values.out) {
    const content = values.out.endsWith('.json')
      ? JSON.stringify({ samples: sim.history, events: sim.events }, null, 2)
      : historyCsv(sim.history)
    fs.writeFileSync(values.out, content)
    console.error(`Saved ${sim.history.length} samples to ${values.out}`)
  }
}

async function runLive (cfg, values) {
  const runner = new Runner(cfg, { speed: values.speed ? toNumber(values.speed, 'speed') : 1 })
  runner.setSpeed(runner.speed)
  if (values.scenario) runner.startScenario(values.scenario)

  if (!values['no-devices']) {
    try {
      await runner.startProtocols()
    } catch (err) {
      if (err.code === 'EADDRINUSE') throw new Error(`Port ${err.port} is already in use. Is another simulator running?`)
      throw err
    }
  }

  const api = createApi(runner)
  let port
  try {
    port = await api.listen(cfg.ports.api, cfg.host)
  } catch (err) {
    if (err.code === 'EADDRINUSE') throw new Error(`Port ${cfg.ports.api} is already in use. Try --port <n>.`)
    throw err
  }
  runner.start()

  const { fleet, ports } = cfg
  const count = fleet.containers * fleet.minersPerContainer
  console.log(`\n  Control panel   http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${port}`)
  if (!values['no-devices']) {
    console.log(`  Miners          ${cfg.host}:${ports.minerBase}-${ports.minerBase + count - 1} (${count} devices)`)
    for (const model of publicModels()) {
      const used = fleet.models.filter((id) => id === model.id).length
      if (used) console.log(`    ${model.brand.padEnd(13)} ${String(used).padStart(4)} × ${model.name}, ${model.protocol}`)
    }
    console.log(`  SATEC meter     ${cfg.host}:${ports.meter}`)
    console.log(`  Seneca sensors  ${cfg.host}:${ports.sensorBase}-${ports.sensorBase + fleet.containers - 1}`)
    console.log(`  F2Pool API      http://${cfg.host}:${ports.pool}`)
  }
  console.log('')
  if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost') {
    console.warn('  WARNING: the control API has no login. Anyone who can reach this address can control the simulator.\n')
  }

  const shutdown = async () => {
    await Promise.all([runner.stop(), api.close()])
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

async function main () {
  const { values, command } = parseCli()
  if (values.help) {
    console.log(HELP)
    return
  }
  const cfg = buildFromCli(values)

  if (command === 'mdk-config') {
    console.log(JSON.stringify(new Runner(cfg).mdkConfig(), null, 2))
    return
  }
  if (command) throw new Error(`Unknown command: ${command}. Run with --help for usage.`)

  if (values.headless) runHeadless(cfg, values)
  else await runLive(cfg, values)
}

main().catch((err) => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})
