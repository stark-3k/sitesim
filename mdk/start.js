#!/usr/bin/env node
'use strict'

// One command for the whole stack: the simulator, a real MDK Kernel, a Worker per
// device family, and optionally the curtailment app.
//
//   node mdk/start.js                                  Start, then keep running
//   node mdk/start.js --app curtailment                Also run the curtailment app
//   node mdk/start.js --app curtailment --cap-kw 300   ...with a site power cap
//   node mdk/start.js --app curtailment --scenario curtailment --exit
//                                                      Score the app on a scenario

const fs = require('fs')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const { parseArgs } = require('util')
const { setTimeout: sleep } = require('timers/promises')
const { startStack, surviveFetchSocketBug } = require('./stack')
const { simApi: api } = require('./sim-client')
const { CurtailmentResponder } = require('./curtailment')
const { MdkBridge } = require('./bridge')

const PROJECT = path.join(__dirname, '..')
const SITESIM = path.join(PROJECT, 'bin', 'sitesim.js')
const MDK_NODE_MAJOR = 24
const SIM_START_TIMEOUT_MS = 15000
const BRIDGE_PORT = 8090

const HELP = `node mdk/start.js [options]

  --dir <path>          Where setup put MDK (default .mdk)
  --port <n>            Simulator control panel port (default 8080)
  --bridge-port <n>     Port the panel reads MDK's view from (default 8090)
  --app curtailment     Run the curtailment app
  --cap-kw <n>          The app's site power cap, also settable in the panel
  --scenario <id>       Start this scenario from a clean simulation
  --exit                Stop when the scenario ends, and print how it went
  --verbose             Show every Worker's command log
  -h, --help            Show this help

Run node mdk/setup.js once first.
`

function fail (message) {
  console.error(message)
  process.exit(1)
}

// Uses a simulator that's already running, or starts one tied to this process.
async function ensureSimulator (base, port) {
  try {
    await api(base, '/api/fleet')
    console.log(`Using the simulator already running at ${base}`)
    return null
  } catch {
    // Nothing there yet.
  }
  console.log('Starting the simulator…')
  const child = spawn(process.execPath, [SITESIM, '--port', String(port)], { stdio: ['ignore', 'ignore', 'inherit'] })
  const deadline = Date.now() + SIM_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('The simulator stopped while starting. Its error is above.')
    try {
      await api(base, '/api/fleet')
      return child
    } catch {
      await sleep(250)
    }
  }
  child.kill()
  throw new Error('The simulator did not start in time.')
}

// Device lists come from the Kernel, as they would for any MDK app.
function devicesFrom (workers) {
  const miners = []
  let meterId = null
  for (const worker of workers) {
    const family = worker.workerId.replace(/^sim-/, '')
    if (family === 'satec') meterId = worker.deviceIds[0]
    else if (!['seneca', 'f2pool'].includes(family)) {
      for (const id of worker.deviceIds) miners.push({ id, brand: family })
    }
  }
  return { miners, meterId }
}

// The same site and scenario with nothing responding, for comparison.
function baselineFor (fleet, scenario) {
  const mix = Object.entries(fleet.counts).filter(([, count]) => count > 0).map(([id, count]) => `${id}=${count}`).join(',')
  const out = execFileSync(process.execPath, [
    SITESIM, '--headless', '--scenario', scenario,
    '--containers', String(fleet.containers),
    '--miners-per-container', String(fleet.minersPerContainer),
    '--mix', mix
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out).scenario
}

function printComparison (withApp, baseline) {
  const row = (label, key, unit = '$') => {
    const fmt = (value) => unit === '$' ? `$${value.toFixed(2)}` : `${value.toFixed(1)} ${unit}`
    return `  ${label.padEnd(18)}${fmt(baseline[key]).padStart(12)}${fmt(withApp[key]).padStart(12)}`
  }
  console.log(`\n${withApp.name}\n  ${''.padEnd(18)}${'No app'.padStart(12)}${'With app'.padStart(12)}`)
  console.log(row('Revenue', 'revenueUsd'))
  console.log(row('Power cost', 'powerCostUsd'))
  console.log(row('Penalties', 'penaltyUsd'))
  console.log(row('Over-limit energy', 'overLimitKwh', 'kWh'))
  console.log(row('Profit', 'profitUsd'))
}

async function main () {
  surviveFetchSocketBug()
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      port: { type: 'string' },
      'bridge-port': { type: 'string' },
      app: { type: 'string' },
      'cap-kw': { type: 'string' },
      scenario: { type: 'string' },
      exit: { type: 'boolean' },
      verbose: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  })
  if (values.help) {
    console.log(HELP)
    return
  }
  if (values.app && values.app !== 'curtailment') fail(`Unknown app: ${values.app}. The one available is: curtailment`)
  const capKw = values['cap-kw'] === undefined ? null : Number(values['cap-kw'])
  if (capKw !== null && !(capKw > 0)) fail('--cap-kw has to be a positive number of kW.')
  if (values.exit && !values.scenario) fail('--exit needs --scenario, so it knows when to stop.')

  const major = Number(process.versions.node.split('.')[0])
  if (major < MDK_NODE_MAJOR) fail(`MDK needs Node ${MDK_NODE_MAJOR} or newer, and this is ${process.version}.`)

  const dir = path.resolve(values.dir || path.join(PROJECT, '.mdk'))
  const mdkDir = process.env.MDK_PATH || path.join(dir, 'mdk')
  const workersDir = process.env.VENDOR_WORKERS || path.join(dir, 'workers')
  if (!fs.existsSync(path.join(mdkDir, 'node_modules'))) fail(`MDK isn't installed in ${mdkDir}. Run: node mdk/setup.js`)

  // Vendor Workers log every physical command to the console.
  if (!values.verbose) {
    const info = console.info
    console.info = (...args) => {
      if (typeof args[0] === 'string' && args[0].includes('"event":"physical_command"')) return
      info(...args)
    }
  }

  const port = Number(values.port || 8080)
  const base = `http://127.0.0.1:${port}`
  const child = await ensureSimulator(base, port)

  let stack
  let app
  let bridge
  let closing = false
  const shutdown = async (code = 0) => {
    if (closing) return
    closing = true
    if (app) app.stop()
    if (bridge) await bridge.stop()
    if (stack) await stack.close()
    if (child) child.kill()
    process.exit(code)
  }
  process.once('SIGINT', () => shutdown())
  process.once('SIGTERM', () => shutdown())

  try {
    console.log('Starting the MDK Kernel and Workers…')
    const config = await api(base, '/api/mdk/config')
    stack = await startStack({ mdkDir, workersDir, config })
    const { miners, meterId } = devicesFrom(stack.workers)

    console.log(`\nMDK is connected to the simulator: ${stack.workers.length} Workers ready.`)
    for (const worker of stack.workers) console.log(`  ${worker.workerId.padEnd(16)}${worker.deviceIds.length} device(s)`)

    // The panel's 3D view reads MDK's picture of the site from here.
    bridge = new MdkBridge({
      client: stack.client,
      workers: stack.workers,
      siteMap: await api(base, '/api/mdk/site-map'),
      allowOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
      log: (message) => console.log(`[bridge] ${message}`)
    })
    await bridge.resolveDevices()
    await bridge.poll()
    const bridgePort = await bridge.listen(Number(values['bridge-port'] || BRIDGE_PORT))
    bridge.startPolling()

    console.log(`\nControl panel: ${base}`)
    console.log(`MDK bridge:    http://127.0.0.1:${bridgePort}, read by the 3D view's "MDK" data source\n`)

    if (values.scenario) {
      await api(base, '/api/control', { action: 'reset' })
      await api(base, '/api/scenarios/start', { id: values.scenario })
    }

    if (values.app === 'curtailment') {
      app = new CurtailmentResponder({
        client: stack.client,
        miners,
        meterId,
        capKw,
        // Stands in for a utility and a market feed, as neither is an MDK device.
        getSignals: async () => {
          const { t, site, env } = await api(base, '/api/state')
          return {
            nowMs: t * 1000,
            limitKw: site.limitKw,
            gridAlert: site.gridAlert,
            priceUsdKwh: env.priceUsdKwh,
            hashpriceUsdThDay: env.hashpriceUsdThDay
          }
        },
        log: (message) => console.log(`[curtailment] ${message}`)
      })
      app.start()
      bridge.app = app
      console.log(`Curtailment app running on ${miners.length} miners.`)
    }

    const fleetAtStart = JSON.stringify(config)
    let warned = false
    while (!closing) {
      await sleep(2000)
      const state = await api(base, '/api/state')
      if (!warned && JSON.stringify(await api(base, '/api/mdk/config')) !== fleetAtStart) {
        warned = true
        console.warn('\nThe fleet changed in the panel, so these Workers are out of date. Restart this command to reconnect them.\n')
      }
      if (values.exit && !state.scenario && state.scenarioResult?.id === values.scenario) {
        const fleet = await api(base, '/api/fleet')
        printComparison(state.scenarioResult, baselineFor(fleet, values.scenario))
        if (app) {
          const { notBack } = app.status()
          console.log(`\n  ${app.steps} return step(s). ${app.rejected} command(s) failed. ${notBack?.length ?? 0} miner(s) didn't come back.`)
          console.log(`  At the end: ${app.slept.size} still asleep, ${app.throttled.size} still on eco.`)
        }
        await shutdown(0)
      }
    }
  } catch (err) {
    console.error(`\n${err.message}`)
    await shutdown(1)
  }
}

main().catch((err) => fail(err.message))
