'use strict'

const path = require('path')
const Simulation = require('./engine/simulation')
const { loadScenarios } = require('./engine/scenarios')
const { MinerServers } = require('./protocols/miners')
const { MODELS } = require('./engine/models')
const { buildConfig } = require('./config')
const { API_PASSWORD, API_ACCOUNT } = require('./protocols/whatsminer')
const { PASSWORD: PROTO_PASSWORD } = require('./protocols/proto')
const { createSatecServer } = require('./protocols/satec')
const { createSenecaServers } = require('./protocols/seneca')
const F2PoolServer = require('./protocols/f2pool')

const TICK_MS = 50
const STEP_BUDGET_MS = 30
const SPEEDS = [1, 10, 60, 300, 1800, 3600]
const ACTIVE_WINDOW_MS = 15000
const MAX_FLEET = 2000
const MAX_CONTAINERS = 50

// MDK refuses two devices at one IP address by default, and every simulated
// device shares the simulator's address, each on its own port.
const LOCAL_DEVICES = { allowDuplicateIPs: true }
const SENSOR_CHANNELS = ['inlet', 'exhaust', 'ambient', 'hottest-chip']
const METER_SERIAL = 'SATEC-SIM-1'

const SCENARIO_DIR = path.join(__dirname, '..', 'scenarios')

// Counts what connects, so the panel can show when real Workers are polling.
class ProtocolStats {
  constructor () {
    this.kinds = {}
  }

  record (kind, device) {
    const entry = this.kinds[kind] ||= { requests: 0, lastAt: 0, devices: new Map() }
    entry.requests++
    entry.lastAt = Date.now()
    entry.devices.set(device, entry.lastAt)
  }

  view (now = Date.now()) {
    const out = {}
    for (const [kind, entry] of Object.entries(this.kinds)) {
      let devices = 0
      for (const seen of entry.devices.values()) if (now - seen < ACTIVE_WINDOW_MS) devices++
      out[kind] = { requests: entry.requests, active: now - entry.lastAt < ACTIVE_WINDOW_MS, devices }
    }
    return out
  }
}

// Owns the live simulation: runs it against the wall clock and hosts the device
// servers, which reach the simulation through a getter so reset can swap it.
class Runner {
  constructor (cfg, opts = {}) {
    this.cfg = cfg
    this.opts = opts
    this.sim = new Simulation(cfg)
    this.scenarios = loadScenarios(opts.scenarioDir || SCENARIO_DIR)
    this.stats = new ProtocolStats()
    this.speed = opts.speed || 1
    this.paused = false
    this.actualSpeed = 0
    this.closers = []
    this.deviceClosers = null
    this.generation = 1
    this.applyingFleet = false
  }

  async startProtocols () {
    const getSim = () => this.sim
    await this._startFleetDevices()

    const satec = createSatecServer(getSim, this.stats)
    await satec.start()
    this.closers.push(() => satec.stop())

    this.f2pool = new F2PoolServer(getSim, this.stats)
    await this.f2pool.start()
    this.closers.push(() => this.f2pool.stop())
  }

  // The devices whose ports depend on the fleet: miners, and a sensor per container.
  async _startFleetDevices () {
    const getSim = () => this.sim
    const miners = new MinerServers(getSim, this.stats)
    this.deviceClosers = [() => miners.stop()]
    await miners.start()
    for (const server of createSenecaServers(getSim, this.stats)) {
      this.deviceClosers.push(() => server.stop())
      await server.start()
    }
  }

  async _stopFleetDevices () {
    await Promise.all((this.deviceClosers || []).map((close) => close()))
    this.deviceClosers = []
  }

  start () {
    let last = Date.now()
    let credit = 0
    let measureAt = last
    let measureSteps = 0

    this.timer = setInterval(() => {
      const now = Date.now()
      const elapsedMs = now - last
      last = now

      if (!this.paused) {
        credit += (elapsedMs / 1000) * this.speed
        const deadline = now + STEP_BUDGET_MS
        let steps = 0
        while (credit >= 1) {
          this.sim.step(1)
          credit -= 1
          steps++
          // Checking the clock every step is measurable at 3600x.
          if (steps % 32 === 0 && Date.now() >= deadline) {
            // Too slow to keep up: drop the backlog, and report the real speed.
            credit = 0
            break
          }
        }
        measureSteps += steps
      }

      if (now - measureAt >= 1000) {
        this.actualSpeed = measureSteps / ((now - measureAt) / 1000)
        measureAt = now
        measureSteps = 0
      }
    }, TICK_MS)
  }

  setSpeed (speed) {
    const value = Number(speed)
    if (!SPEEDS.includes(value)) throw new Error(`ERR_SPEED_INVALID: choose one of ${SPEEDS.join(', ')}`)
    this.speed = value
  }

  reset () {
    this.sim = new Simulation(this.cfg)
    this.generation++
    if (this.f2pool) this.f2pool.sample()
  }

  fleetView () {
    const { fleet, ports } = this.cfg
    const counts = Object.fromEntries(Object.keys(MODELS).map((id) => [id, 0]))
    for (const id of fleet.models) counts[id]++
    return {
      containers: fleet.containers,
      minersPerContainer: fleet.minersPerContainer,
      counts,
      maxMiners: Math.min(MAX_FLEET, ports.meter - ports.minerBase),
      maxContainers: MAX_CONTAINERS
    }
  }

  // Swaps in a new fleet without restarting the process. The simulation starts
  // over, and if a new port is taken, the old fleet comes back as it was.
  async applyFleet ({ containers, minersPerContainer, counts }) {
    if (this.applyingFleet) throw new Error('ERR_FLEET_CHANGE_IN_PROGRESS')
    const whole = (value) => Number.isInteger(value) && value >= 1
    if (!whole(containers) || containers > MAX_CONTAINERS) throw new Error(`ERR_FLEET_CONTAINERS_INVALID: use 1 to ${MAX_CONTAINERS}`)
    if (!whole(minersPerContainer)) throw new Error('ERR_FLEET_MINERS_INVALID: use a whole number of at least 1')
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw new Error('ERR_FLEET_COUNTS_INVALID')
    const mix = {}
    let assigned = 0
    for (const [id, count] of Object.entries(counts)) {
      if (!MODELS[id]) throw new Error(`ERR_MODEL_INVALID: ${id}`)
      if (!Number.isInteger(count) || count < 0) throw new Error(`ERR_FLEET_COUNTS_INVALID: ${id}`)
      if (count > 0) mix[id] = count
      assigned += count
    }
    const total = containers * minersPerContainer
    if (assigned !== total) throw new Error(`ERR_FLEET_COUNTS_MISMATCH: brands add up to ${assigned}, but the containers hold ${total}`)

    const { source } = this.cfg
    const next = buildConfig({ ...source, fleet: { ...source.fleet, containers, minersPerContainer, mix } })

    this.applyingFleet = true
    const previous = this.cfg
    const hosted = this.deviceClosers !== null
    try {
      if (hosted) await this._stopFleetDevices()
      this.cfg = next
      this.sim = new Simulation(next)
      if (hosted) {
        try {
          await this._startFleetDevices()
        } catch (err) {
          await this._stopFleetDevices()
          this.cfg = previous
          this.sim = new Simulation(previous)
          await this._startFleetDevices()
          if (err.code === 'EADDRINUSE') throw new Error(`ERR_FLEET_PORT_IN_USE: port ${err.port} is taken, so the fleet was not changed`)
          throw err
        }
      }
      this.generation++
      if (this.f2pool) this.f2pool.sample()
      return this.fleetView()
    } finally {
      this.applyingFleet = false
    }
  }

  startScenario (id) {
    const scenario = this.scenarios.get(id)
    if (!scenario) throw new Error(`ERR_SCENARIO_NOT_FOUND: ${id}`)
    this.sim.startScenario(scenario)
    this.setSpeed(scenario.speed)
    this.paused = false
  }

  runtime () {
    return {
      generation: this.generation,
      paused: this.paused,
      speed: this.speed,
      actualSpeed: this.actualSpeed,
      speeds: SPEEDS,
      protocols: this.stats.view()
    }
  }

  // What to hand MDK's Workers. Field names match each boot function's options.
  mdkConfig () {
    const { sim, cfg } = this
    const { primary } = cfg.pools
    const ofModel = (model) => sim.miners.filter((miner) => miner.model === model)

    // Vendor-maintained Workers take a device list on WorkerRuntimeV2. Field
    // names come from each Worker's device configuration.
    const vendorConfig = {
      antminer: (miner) => ({ address: cfg.host, port: miner.port, username: 'root', password: 'root' }),
      whatsminer: (miner) => ({ address: cfg.host, port: miner.port, apiVersion: '3.0.3', account: API_ACCOUNT, password: API_PASSWORD }),
      sealminer: (miner) => ({ address: cfg.host, port: miner.port, series: 'a2' }),
      luxos: (miner) => ({ address: cfg.host, port: miner.port }),
      proto: (miner) => ({ address: cfg.host, port: miner.port, protocol: 'http', password: PROTO_PASSWORD })
    }
    const vendors = {}
    for (const [model, config] of Object.entries(vendorConfig)) {
      const miners = ofModel(model)
      if (!miners.length) continue
      vendors[model] = {
        worker: MODELS[model].worker,
        devices: miners.map((miner) => ({ deviceId: miner.id, config: config(miner) }))
      }
    }
    const avalonMiners = ofModel('avalon')

    return {
      ...(avalonMiners.length && {
        avalon: {
          model: 'a1346',
          conf: LOCAL_DEVICES,
          seedDevices: avalonMiners.map((miner) => ({
            info: { serialNum: miner.serial },
            opts: { address: cfg.host, port: miner.port, username: 'root', password: 'root' }
          }))
        }
      }),
      ...vendors,
      satec: {
        model: 'pm180',
        seedDevices: [{
          info: { serialNum: METER_SERIAL },
          opts: { address: cfg.host, port: cfg.ports.meter, unitId: 1 }
        }]
      },
      seneca: {
        conf: LOCAL_DEVICES,
        seedDevices: sim.containers.flatMap((container) => (
          SENSOR_CHANNELS.map((channel, index) => ({
            info: { serialNum: `SEN-${container.id}-${channel}` },
            opts: { address: cfg.host, port: container.sensorPort, unitId: 0, register: 3 + index }
          }))
        ))
      },
      f2pool: {
        apiUrl: `http://${cfg.host}:${cfg.ports.pool}`,
        accounts: [primary.username],
        apiSecret: primary.apiSecret
      }
    }
  }

  // What MDK can't report: which device sits where. A real site would write this by hand.
  siteMap () {
    const { sim } = this
    return {
      containers: sim.containers.map((c) => ({ id: c.id, name: c.name, capacityKw: c.capacityKw })),
      miners: sim.miners.map((m) => ({
        id: m.id,
        c: m.containerId,
        model: m.model,
        brand: m.spec.brand,
        serial: m.serial,
        nth: m.spec.nominalThs,
        nw: m.spec.nominalW
      })),
      sensors: sim.containers.flatMap((c) => SENSOR_CHANNELS.map((channel) => ({
        serial: `SEN-${c.id}-${channel}`,
        container: c.id,
        channel
      }))),
      meter: { serial: METER_SERIAL }
    }
  }

  async stop () {
    clearInterval(this.timer)
    await Promise.all(this.closers.map((close) => close()))
    this.closers = []
    await this._stopFleetDevices()
  }
}

module.exports = { Runner, SPEEDS }
