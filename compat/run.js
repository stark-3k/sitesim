'use strict'

// Runs real MDK code against the simulator: first its device drivers directly,
// then a live Kernel, Workers and client. Needs an MDK checkout with its
// dependencies installed, and Node 24 or newer (MDK's own requirement).
//
//   MDK_PATH=/path/to/mdk node compat/run.js [--no-stack] [--vendors-only]
//
// To also run the vendor-maintained miner Workers, clone each one with its
// dependencies installed into one directory, and point VENDOR_WORKERS at it:
//
//   VENDOR_WORKERS=/path/to/clones MDK_PATH=/path/to/mdk node compat/run.js

const os = require('os')
const path = require('path')
const fs = require('fs')
const { createRequire } = require('module')
const { setTimeout: sleep } = require('timers/promises')

// MDK's pool API client waits a second between calls, except under test.
process.env.NODE_ENV = 'test'
const { buildConfig } = require('../src/config')
const { Runner } = require('../src/runner')

const MDK_PATH = process.env.MDK_PATH
if (!MDK_PATH) {
  console.error('Set MDK_PATH to an MDK checkout with its dependencies installed.')
  process.exit(2)
}
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error(`MDK needs Node 24 or newer, and this is ${process.version}.`)
  process.exit(2)
}

const mdkRequire = createRequire(path.join(path.resolve(MDK_PATH), 'package.json'))

let passed = 0
const failures = []

// Known MDK issue: AvalonMiner.setLED(true) starts a two-minute timer to turn the
// LED off, with no error handling. If the miner is unreachable by then, the error
// is an unhandled rejection, which ends a Node process that has no handler.
// The Avalon checks stop their miner before that timer fires.
const AVALON_PORT = 24030
process.on('unhandledRejection', (err) => {
  if (err?.code === 'ECONNREFUSED' && err.port === AVALON_PORT) {
    console.log('  note  unhandled rejection from the Avalon driver\'s LED timer (known MDK issue)')
    return
  }
  throw err
})

function check (name, ok, detail) {
  if (ok) {
    passed++
    console.log(`  ok    ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`)
  }
}

const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance
const errorNames = (snap) => (snap.stats.errors || []).map((e) => e.name)

function advance (sim, seconds) {
  for (let i = 0; i < seconds; i++) sim.step(1)
}

function makeRunner () {
  return new Runner(buildConfig({
    seed: 7,
    fleet: { containers: 2, minersPerContainer: 4, mix: { avalon: 1 } },
    // Away from the defaults, so this can run beside a live simulator.
    ports: { api: 0, minerBase: AVALON_PORT, meter: 25020, sensorBase: 25021, pool: 28000 }
  }))
}

async function testAvalonDriver (runner) {
  console.log('\nAvalon driver (real AvalonMiner against the simulated cgminer API)')
  const { plugin } = mdkRequire('@tetherto/mdk-worker-avalon')
  const { sim } = runner
  const m = sim.miners[0]
  const device = await plugin.connect({
    address: '127.0.0.1',
    port: m.port,
    username: 'root',
    password: 'root',
    timeout: 3000,
    type: 'miner-av-a1346'
  }, { deviceId: m.id })
  const clear = () => sim.clearFaults(() => true)

  try {
    advance(sim, 60)
    let snap = await device._prepSnap()
    check('a healthy miner reports mining with no errors', snap.stats.status === 'mining' && !snap.stats.errors, snap.stats)
    check('hashrate matches the engine', near(snap.stats.hashrate_mhs.avg / 1e6, m.ema.s30, 0.01), snap.stats.hashrate_mhs)
    check('power matches the engine', near(snap.stats.power_w, m.powerW, 1), snap.stats.power_w)
    check('temperature matches the engine', near(snap.stats.temperature_c.avg, m.chipC, 1), snap.stats.temperature_c.avg)
    check('efficiency is close to the nominal 30 W/TH', snap.stats.efficiency_w_ths > 25 && snap.stats.efficiency_w_ths < 36, snap.stats.efficiency_w_ths)
    check('three pools are reported', snap.config.pool_config.length === 3, snap.config.pool_config)

    sim.injectFault({ type: 'hashboard_failure', target: `miner:${m.id}`, params: { boards: 1 } })
    advance(sim, 30)
    snap = await device._prepSnap()
    check('a board failure raises hashboard_error', errorNames(snap).includes('hashboard_error'), errorNames(snap))
    clear()

    sim.injectFault({ type: 'psu_failure', target: `miner:${m.id}` })
    advance(sim, 5)
    snap = await device._prepSnap()
    check('a PSU failure raises power_error_status', errorNames(snap).includes('power_error_status'), errorNames(snap))
    clear()
    advance(sim, 200)

    sim.injectFault({ type: 'control_board_fault', target: `miner:${m.id}` })
    snap = await device._prepSnap()
    check('a control board fault raises control_board_exception', errorNames(snap).includes('control_board_exception'), errorNames(snap))
    clear()

    for (const id of sim.pools.keys()) sim.injectFault({ type: 'pool_outage', target: `pool:${id}` })
    advance(sim, 5)
    snap = await device._prepSnap()
    check('losing every pool raises all_pools_dead', errorNames(snap).includes('all_pools_dead'), errorNames(snap))
    check('losing every pool raises pool_connect_failed', errorNames(snap).includes('pool_connect_failed'), errorNames(snap))
    clear()

    // With no fan it trips, cools, restarts and trips again, so stop at the first.
    sim.injectFault({ type: 'fan_failure', target: `miner:${m.id}`, params: { severity: 1 } })
    for (let i = 0; i < 1800 && m.state !== 'tripped'; i++) sim.step(1)
    snap = await device._prepSnap()
    // Known MDK issue: the driver stores ECHU as an array, then compares it to the
    // string '128', so it can't raise this alert on any device. Check the field.
    const estats = await device.getEStats()
    check('fan loss reports the overheating code the driver reads', estats.error_code[0] === '128', estats.error_code)
    check('the thermal cut-out opened', m.state === 'tripped', m.state)
    clear()
    advance(sim, 1500)
    check('the miner recovers once the fan is repaired', m.state === 'mining', m.state)

    await device.suspendMining()
    advance(sim, 60)
    snap = await device._prepSnap()
    check('softoff puts the miner to sleep', m.state === 'sleeping', m.state)
    check('a sleeping miner reports sleeping, not an error', snap.stats.status === 'sleeping' && !errorNames(snap).includes('power_error_status'), snap.stats.status)
    check('a sleeping miner draws little power', snap.stats.power_w < 200, snap.stats.power_w)

    await device.setPowerMode('high')
    await sleep(100)
    check('setPowerMode(high) changes the work mode', m.workMode === 1, m.workMode)
    check('setPowerMode(high) reboots, as the real driver expects', m.state === 'booting', m.state)
    await assertRejects('a booting miner refuses connections', () => device.getVersion())
    advance(sim, 200)
    snap = await device._prepSnap()
    check('high mode shows after the reboot', snap.config.power_mode === 'high' && m.state === 'mining', snap.config.power_mode)
    await device.setPowerMode('normal')
    await sleep(100)
    advance(sim, 200)

    const led = await device.setLED(true)
    check('setLED succeeds and lights the LED', led.success && m.led, led)
    await device.setLED(false)

    const version = await device.getVersion()
    check('getVersion parses', version.model === '1346-116' && Boolean(version.mac), version)

    // Known MDK issue: the driver authenticates with this.username and
    // this.password, which nothing sets, so a stock setPools gets "Auth Failed".
    // The simulator refuses it as MDK's own mock does. Set them to test the rest.
    const newPools = () => [
      { url: 'stratum+tcp://new.pool.sim:3333', worker_name: 'acct', worker_password: 'x' },
      { url: 'stratum+tcp://backup.pool.sim:3333', worker_name: 'acct', worker_password: 'x' }
    ]
    const stock = await device.setPools(newPools(), false)
    check('stock setPools is refused for its unset login, not silently accepted', stock.success === false && m.pools[0].url !== 'stratum+tcp://new.pool.sim:3333', stock)
    // The driver reboots the miner even after that failure.
    advance(sim, 200)
    device.username = 'root'
    device.password = 'root'
    const result = await device.setPools(newPools(), false)
    check('setPools succeeds', result.success, result)
    check('setPools reaches the engine', m.pools[0].url === 'stratum+tcp://new.pool.sim:3333', m.pools[0].url)
    advance(sim, 200)
    check('the miner mines on its newly set pool', m.activePool === 0 && sim.poolForUrl(m.pools[0].url).id === 'new.pool.sim', m.activePool)

    sim.injectFault({ type: 'network_loss', target: `miner:${m.id}` })
    await assertRejects('a miner with no network fails the request', () => device.getVersion())
    clear()
  } finally {
    await plugin.disconnect(device)
  }
}

async function assertRejects (name, fn) {
  try {
    const value = await fn()
    check(name, false, { resolved: value })
  } catch {
    check(name, true)
  }
}

async function testSatecDriver (runner) {
  console.log('\nSATEC driver (real SatecPowerMeter over Modbus TCP)')
  const { plugin } = mdkRequire('@tetherto/mdk-worker-satec')
  const { sim, cfg } = runner
  const device = await plugin.connect({
    address: '127.0.0.1',
    port: cfg.ports.meter,
    unitId: 1,
    timeout: 3000,
    type: 'powermeter-satec-pm180'
  }, { deviceId: 'meter' })

  try {
    advance(sim, 120)
    let snap = await device._prepSnap()
    check('power is within one register step of the engine', near(snap.stats.power_w / 1000, sim.site.powerKw, 22), { meter: snap.stats.power_w, engine: sim.site.powerKw })
    check('voltage reads as a three-phase value', snap.stats.tension_v > 0, snap.stats.tension_v)
    const iv = snap.stats.powermeter_specific.instantaneous_values
    check('current follows from the load', iv.current_i1_a >= 0, iv.current_i1_a)
    check('power factor decodes', near(iv.power_factor_l1, 0.98, 0.01), iv.power_factor_l1)

    sim.injectFault({ type: 'grid_outage' })
    advance(sim, 30)
    snap = await device._prepSnap()
    check('a grid outage reads zero power and voltage', snap.stats.power_w === 0 && iv && snap.stats.powermeter_specific.instantaneous_values.voltage_v1_v12_v === 0, snap.stats.power_w)
    sim.clearFaults(() => true)
    advance(sim, 200)
  } finally {
    await plugin.disconnect(device)
  }
}

async function testSenecaDriver (runner) {
  console.log('\nSeneca driver (real SenecaSensor over Modbus TCP)')
  const { plugin } = mdkRequire('@tetherto/mdk-worker-seneca')
  const { sim } = runner
  const container = sim.containers[0]
  const connect = (register) => plugin.connect({
    address: '127.0.0.1',
    port: container.sensorPort,
    unitId: 0,
    register,
    timeout: 3000,
    type: 'sensor-temp-seneca-temp-seneca'
  }, { deviceId: `sensor-${register}` })

  const inlet = await connect(3)
  const ambient = await connect(5)
  try {
    let snap = await inlet._prepSnap()
    check('channel 1 reads the container inlet', near(snap.stats.temp_c, container.inletC, 0.1), { sensor: snap.stats.temp_c, engine: container.inletC })
    snap = await ambient._prepSnap()
    check('channel 3 reads outdoor temperature', near(snap.stats.temp_c, sim.env.ambientC, 0.1), { sensor: snap.stats.temp_c, engine: sim.env.ambientC })

    sim.injectFault({ type: 'sensor_fault', target: container.id })
    snap = await inlet._prepSnap()
    check('a sensor fault raises sensor_error', snap.stats.status === 'error' && errorNames(snap).includes('sensor_error'), snap.stats)
    sim.clearFaults(() => true)
  } finally {
    await plugin.disconnect(inlet)
    await plugin.disconnect(ambient)
  }
}

async function waitFor (predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(250)
  }
  check(`timed out waiting for ${label}`, false)
  return false
}

async function testFullStack (runner) {
  console.log('\nFull stack (real Kernel, Workers and client)')
  const { getKernel, waitForDiscovery, shutdown } = mdkRequire('@tetherto/mdk-core')
  const { createMdkClient } = mdkRequire('@tetherto/mdk-client')
  const { generateCredential } = mdkRequire('@tetherto/mdk-identity')
  const { callerKeyPair, trustKernel } = mdkRequire('@tetherto/mdk-core/lib/local-discovery')
  const { startAvalonWorker } = mdkRequire('@tetherto/mdk-worker-avalon')
  const { startSatecWorker } = mdkRequire('@tetherto/mdk-worker-satec')
  const { startSenecaWorker } = mdkRequire('@tetherto/mdk-worker-seneca')
  const { startF2poolWorker } = mdkRequire('@tetherto/mdk-worker-f2pool')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitesim-compat-'))
  const account = 'sitesim-compat'
  const credential = generateCredential()
  const config = runner.mdkConfig()
  const { sim } = runner
  const stopper = setInterval(() => sim.step(1), 100)

  let kernel
  let client
  const workers = []
  try {
    kernel = await getKernel({
      root,
      rbac: {
        enforcement: 'deny',
        roles: [{
          name: 'compat',
          rules: [
            { resources: ['devices'], verbs: ['read', 'write'] },
            { resources: ['workers'], verbs: ['list'] }
          ]
        }],
        bindings: [{ role: 'compat', subjects: [{ kind: 'ServiceAccount', name: account }] }]
      },
      serviceAccounts: [{ name: account, publicKey: credential.publicKey }]
    })
    const allowedKeys = [kernel.getClientPublicKey()]
    const store = (name) => path.join(root, name)

    const start = async (fn, opts) => {
      const worker = await fn({ allowedKeys, storeDir: store(opts.workerId), ...opts })
      trustKernel(worker.runtime, kernel)
      await kernel.registerWorker(worker.runtime.getPublicKey())
      workers.push(worker)
      return worker
    }

    await start(startAvalonWorker, { workerId: 'sim-avalon', model: 'a1346', conf: config.avalon.conf, seedDevices: config.avalon.seedDevices })
    await start(startSatecWorker, { workerId: 'sim-satec', model: 'pm180', seedDevices: config.satec.seedDevices })
    await start(startSenecaWorker, { workerId: 'sim-seneca', conf: config.seneca.conf, seedDevices: config.seneca.seedDevices })
    const pool = await start(startF2poolWorker, {
      workerId: 'sim-f2pool',
      rack: 'sim-rack',
      conf: { f2pool: config.f2pool }
    })
    check('all four Workers started', workers.length === 4)

    const discovered = await waitForDiscovery(kernel, { minWorkers: 4, timeoutMs: 60000 })
    const ready = discovered.filter((w) => w.state === 'READY')
    check('the Kernel found all four Workers READY', ready.length === 4, discovered.map((w) => [w.workerId, w.state]))

    const avalon = discovered.find((w) => w.workerId === 'sim-avalon')
    check('the Avalon Worker registered the whole fleet', avalon && avalon.deviceIds.length === sim.miners.length, avalon && avalon.deviceIds)

    const caller = callerKeyPair(path.join(root, 'caller'))
    kernel.allowKey(caller.publicKey)
    client = createMdkClient({
      kernelKey: kernel.getPublicKey(),
      kernelKeyPair: caller,
      kernelCredential: { name: account, privateKey: credential.privateKeyPem }
    })
    await client.connect()

    const deviceId = avalon.deviceIds[0]
    const telemetry = await client.pullTelemetry(deviceId, 'metrics')
    const metrics = telemetry.metrics || telemetry
    check('metrics arrive through the Kernel', metrics && Object.keys(metrics).length > 0, telemetry)
    console.log(`        sample: ${JSON.stringify(metrics).slice(0, 160)}`)

    const before = sim.events.length
    const res = await client.sendCommand(deviceId, 'setPowerMode', { mode: 'sleep' })
    check('a command is accepted by the Kernel', Boolean(res), res)
    const asleep = await waitFor(() => sim.miners.some((m) => m.suspended), 15000, 'the command to reach the simulator')
    check('the command changed a simulated miner', asleep)
    check('the simulator logged it as a cgminer write', sim.events.slice(before).some((e) => e.source === 'cgminer'), sim.events.slice(before))

    const meter = discovered.find((w) => w.workerId === 'sim-satec')
    const reading = await client.pullTelemetry(meter.deviceIds[0], 'metrics')
    check('power meter readings arrive through the Kernel', Boolean(reading), reading)

    const sensors = discovered.find((w) => w.workerId === 'sim-seneca')
    check('every sensor channel registered', sensors.deviceIds.length === sim.containers.length * 4, sensors.deviceIds)

    // The Worker fetches on a cron schedule, so call its real fetch code directly
    // rather than waiting up to five minutes for the next run.
    const manager = pool.pool
    await manager.fetchWorkers(new Date())
    const poolWorkers = manager.data.workersData.workers
    check('the pool Worker reads every miner as a worker', poolWorkers.length === sim.miners.length, poolWorkers.length)
    check('it sees earning miners as online', poolWorkers.filter((w) => w.online).length === sim.miners.filter((m) => m.creditedThs > 0).length, poolWorkers.map((w) => [w.name, w.online]))

    await manager.fetchStats(new Date())
    const stats = manager.data.statsData.stats[0]
    const poolModel = sim.pools.get(sim.cfg.pools.primary.id)
    console.log(`        pool stats: hashrate=${stats.hashrate}, workers=${stats.worker_count}, balance=${stats.balance}`)
    check('its hashrate matches the engine', Math.abs(stats.hashrate - poolModel.creditedThs * 1e12) < 5e13, { worker: stats.hashrate, engine: poolModel.creditedThs * 1e12 })
    check('its balance matches what the site has earned', stats.balance > 0 && stats.balance <= poolModel.btcTotal, { worker: stats.balance, engine: poolModel.btcTotal })
    check('it reports the worker count', stats.worker_count === sim.miners.length, stats.worker_count)
  } finally {
    clearInterval(stopper)
    if (client) await client.close().catch(() => {})
    for (const worker of workers) await worker.stop().catch(() => {})
    if (kernel) await shutdown(kernel).catch(() => {})
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const VENDOR_DIRS = {
  antminer: 'antminer-mdk-worker',
  whatsminer: 'whatsminer-mdk-worker',
  sealminer: 'sealminer-mdk-worker',
  luxos: 'luxos-mdk-worker',
  proto: 'proto-tether-mdk-worker'
}

// Hosts each vendor Worker the way MDK's starter site does, then checks that
// telemetry and a sleep command both go through the Kernel to the simulator.
async function testVendorWorkers (dir) {
  console.log('\nVendor Workers (real Workers, Kernel and client)')
  const { getKernel, waitForDiscovery, shutdown } = mdkRequire('@tetherto/mdk-core')
  const { createMdkClient } = mdkRequire('@tetherto/mdk-client')
  const { generateCredential } = mdkRequire('@tetherto/mdk-identity')
  const { callerKeyPair } = mdkRequire('@tetherto/mdk-core/lib/local-discovery')
  const { WorkerRuntimeV2 } = mdkRequire('@tetherto/mdk-worker')

  const runner = new Runner(buildConfig({
    seed: 7,
    fleet: { containers: 1, minersPerContainer: 25, mix: Object.fromEntries(Object.keys(VENDOR_DIRS).map((id) => [id, 1])) },
    ports: { api: 0, minerBase: 26030, meter: 27020, sensorBase: 27021, pool: 28100 }
  }))
  await runner.startProtocols()
  const { sim } = runner
  advance(sim, 120)
  const ticker = setInterval(() => sim.step(1), 100)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitesim-vendors-'))
  const account = 'sitesim-compat'
  const credential = generateCredential()
  const config = runner.mdkConfig()
  const runtimes = []
  let kernel
  let client
  try {
    kernel = await getKernel({
      root,
      rbac: {
        enforcement: 'deny',
        roles: [{ name: 'compat', rules: [{ resources: ['devices'], verbs: ['read', 'write'] }, { resources: ['workers'], verbs: ['list'] }] }],
        bindings: [{ role: 'compat', subjects: [{ kind: 'ServiceAccount', name: account }] }]
      },
      serviceAccounts: [{ name: account, publicKey: credential.publicKey }]
    })

    for (const [model, folder] of Object.entries(VENDOR_DIRS)) {
      const runtime = new WorkerRuntimeV2(path.join(dir, folder), {
        workerId: `sim-${model}`,
        storeDir: path.join(root, model),
        allowedKeys: [kernel.getClientPublicKey()],
        devices: config[model].devices
      })
      await runtime.start()
      await kernel.registerWorker(runtime.getPublicKey())
      runtimes.push(runtime)
    }

    const discovered = await waitForDiscovery(kernel, { minWorkers: runtimes.length, timeoutMs: 60000 })
    check('every vendor Worker is READY', discovered.filter((w) => w.state === 'READY').length === runtimes.length, discovered.map((w) => [w.workerId, w.state]))

    const caller = callerKeyPair(path.join(root, 'caller'))
    kernel.allowKey(caller.publicKey)
    client = createMdkClient({
      kernelKey: kernel.getPublicKey(),
      kernelKeyPair: caller,
      kernelCredential: { name: account, privateKey: credential.privateKeyPem }
    })
    await client.connect()

    const pull = async (miner) => {
      const telemetry = await client.pullTelemetry(miner.id, 'metrics')
      return telemetry.metrics || telemetry
    }

    // Workers cache device reads for a few seconds, so poll until a reading
    // agrees, or report the last one seen.
    const until = async (name, miner, predicate, timeoutMs = 20000) => {
      const deadline = Date.now() + timeoutMs
      let last
      while (Date.now() < deadline) {
        try {
          last = await pull(miner)
          if (predicate(last)) {
            check(name, true)
            return last
          }
        } catch (err) {
          last = { pullError: err.message }
        }
        await sleep(1000)
      }
      check(name, false, last && { status: last.status, power: last.power, power_mode: last.power_mode, errors: last.errors, pools: last.pools, pullError: last.pullError })
      return last
    }

    const command = async (name, miner, cmd, params, effect) => {
      let res
      try {
        res = await client.sendCommand(miner.id, cmd, params)
      } catch (err) {
        check(name, false, { thrown: err.message })
        return false
      }
      const ok = await waitQuietly(effect, 15000)
      check(name, ok, { result: res })
      return ok
    }

    const waitQuietly = async (predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (await predicate()) return true
        await sleep(200)
      }
      return false
    }

    const hashOf = (metrics) => metrics.hashrate_rt ?? metrics.hashrate_avg
    // SealMiner's Worker reports the firmware's own state names.
    const isMining = (metrics) => ['mining', 'running'].includes(metrics.status)
    const isSleeping = (metrics) => ['sleeping', 'suspended'].includes(metrics.status)
    const hasErrors = (metrics) => Array.isArray(metrics.errors) && metrics.errors.some((e) => !e.severity || !/^info$/i.test(e.severity))

    // How each brand expresses the same three controls.
    const CONTROLS = {
      antminer: {
        wake: ['setPowerMode', { mode: 'normal' }],
        limit: ['setHashratePercent', { pct: 70 }],
        limited: (m) => Math.abs(m.powerScale - 0.7) < 0.01,
        pools: (url) => ({ pools: [{ url, user: 'acct.sim', pass: 'x' }] })
      },
      whatsminer: {
        wake: ['setPowerMode', { mode: 'normal' }],
        limit: ['setPowerPct', { pct: 70 }],
        limited: (m) => Math.abs(m.powerScale - 0.7) < 0.01,
        pools: (url) => ({ pools: [{ url, worker_name: 'acct.sim', worker_password: 'x' }], appendId: false })
      },
      sealminer: {
        wake: ['resume', {}],
        limit: ['setPowerLimit', { watts: 3000 }],
        limited: (m) => Math.abs(m.powerScale - 3000 / m.spec.nominalW) < 0.01,
        pools: (url) => ({ pools: [{ url, user: 'acct.sim', pass: 'x' }] })
      },
      luxos: {
        wake: ['setPowerMode', { mode: 'normal' }],
        // LuxOS has no power limit. Its tuning profiles do that job.
        limit: ['setProfile', { profile: '450MHz' }],
        limited: (m) => m.mode.name === 'eco',
        pools: (url) => ({ pools: [{ url, user: 'acct.sim', password: 'x' }] })
      },
      proto: {
        wake: ['setPowerMode', { mode: 'normal' }],
        limit: ['setPowerTarget', { watts: 2000 }],
        limited: (m) => Math.abs(m.powerScale - 2000 / m.spec.nominalW) < 0.01,
        pools: (url) => ({ pools: [{ url, worker_name: 'acct.sim', worker_password: 'x' }], appendId: false })
      }
    }

    for (const model of Object.keys(VENDOR_DIRS)) {
      console.log(`\n  ${model}`)
      // A miner per area, so one command's cooldown can't hold up the next.
      const [reader, sleeper, limiter, pooler, rebooter] = sim.miners.filter((m) => m.model === model)
      const controls = CONTROLS[model]

      // Values through the Worker, against the engine.
      const metrics = await until(`${model}: reports mining with no errors`, reader, (m) => isMining(m) && !hasErrors(m))
      console.log(`        ${JSON.stringify({ hash: hashOf(metrics), power: metrics.power, temp: metrics.temperature, status: metrics.status, mode: metrics.power_mode })}`)
      check(`${model}: hashrate matches the engine`, Math.abs(hashOf(metrics) - reader.ths) / reader.ths < 0.05, { worker: hashOf(metrics), engine: reader.ths })
      check(`${model}: power matches the engine`, Math.abs(metrics.power - reader.powerW) / reader.powerW < 0.05, { worker: metrics.power, engine: reader.powerW })
      check(`${model}: temperature matches the engine`, Math.abs(metrics.temperature - reader.chipC) < 8, { worker: metrics.temperature, engine: reader.chipC })
      check(`${model}: reports its pools`, Array.isArray(metrics.pools) && metrics.pools.length >= 1, metrics.pools)

      // Faults through the Worker.
      for (const type of ['hashboard_failure', 'psu_failure', 'fan_failure']) {
        const [fault] = sim.injectFault({ type, target: `miner:${reader.id}`, params: type === 'fan_failure' ? { severity: 0.7 } : undefined })
        advance(sim, 5)
        await until(`${model}: ${type} shows as an error`, reader, hasErrors)
        sim.clearFaults((f) => f.id === fault.id)
        advance(sim, 200)
        await until(`${model}: the error clears after ${type}`, reader, (m) => !hasErrors(m) && isMining(m))
      }

      // Every pool down.
      for (const id of sim.pools.keys()) sim.injectFault({ type: 'pool_outage', target: `pool:${id}` })
      advance(sim, 5)
      await until(`${model}: losing all pools shows up`, reader, (m) => hasErrors(m) || (Array.isArray(m.pools) && m.pools.length > 0 && m.pools.every((p) => /dead/i.test(p.status ?? ''))))
      sim.clearFaults((f) => f.type === 'pool_outage')
      advance(sim, 30)

      // Sleep and wake.
      await command(`${model}: sleep reaches the miner`, sleeper, 'setPowerMode', { mode: 'sleep' }, () => sleeper.suspended)
      advance(sim, 60)
      await until(`${model}: reports sleeping`, sleeper, (m) => isSleeping(m) && m.power < 300)
      await command(`${model}: wake reaches the miner`, sleeper, ...controls.wake, () => !sleeper.suspended)
      advance(sim, 120)
      await until(`${model}: reports mining again`, sleeper, (m) => isMining(m) && hashOf(m) > 0)

      // Power control: the command lands, and less power shows in telemetry.
      const fullPower = limiter.powerW
      if (await command(`${model}: ${controls.limit[0]} reaches the miner`, limiter, ...controls.limit, () => controls.limited(limiter))) {
        advance(sim, 300)
        await until(`${model}: telemetry shows less power`, limiter, (m) => m.power < fullPower * 0.85)
      }

      // Pools: the list changes, and the miner earns on the new pool.
      const url = `stratum+tcp://${model}.compat.sim:3333`
      if (await command(`${model}: setupPools reaches the miner`, pooler, 'setupPools', controls.pools(url), () => pooler.pools.some((p) => p.url === url))) {
        advance(sim, 240)
        check(`${model}: the miner mines on the new pool`, pooler.pools[pooler.activePool]?.url === url, pooler.pools.map((p) => p.url))
        await until(`${model}: telemetry shows the new pool`, pooler, (m) => Array.isArray(m.pools) && m.pools.some((p) => (p.url ?? p.pool) === url))
      }

      // Reboot, then recovery through the Worker.
      await command(`${model}: reboot reaches the miner`, rebooter, 'reboot', {}, () => rebooter.state === 'booting')
      advance(sim, 240)
      await until(`${model}: comes back after the reboot`, rebooter, (m) => isMining(m) && hashOf(m) > 0, 30000)
    }
  } finally {
    clearInterval(ticker)
    if (client) await client.close().catch(() => {})
    for (const runtime of runtimes) await runtime.stop().catch(() => {})
    if (kernel) await shutdown(kernel).catch(() => {})
    await runner.stop()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function main () {
  const runner = makeRunner()
  await runner.startProtocols()
  try {
    if (process.argv.includes('--vendors-only')) return await finish()
    await testAvalonDriver(runner)
    await testSatecDriver(runner)
    await testSenecaDriver(runner)
    if (!process.argv.includes('--no-stack')) {
      runner.reset()
      await testFullStack(runner)
    }
  } finally {
    await runner.stop()
  }
  await finish()
}

async function finish () {
  if (process.env.VENDOR_WORKERS) await testVendorWorkers(process.env.VENDOR_WORKERS)
  console.log(`\n${passed} passed, ${failures.length} failed`)
  for (const name of failures) console.log(`  - ${name}`)
  process.exit(failures.length ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
