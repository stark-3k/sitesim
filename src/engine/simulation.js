'use strict'

const Rng = require('../rng')
const Environment = require('./environment')
const { Miner, STATE, emptyFx } = require('./miner')
const { CATALOG, CHAOS_TYPES, resolveParams } = require('./faults')
const { MODELS, specFor } = require('./models')

const DAY = 86400
const MAX_EVENTS = 500
const MAX_POOLS = 64

const emptySiteFx = () => ({
  gridDown: false,
  limitFactor: 1,
  gridAlert: false,
  ambientDeltaC: 0,
  priceMult: 1,
  revenueMult: 1,
  meterFrozen: false
})

const emptyContainerFx = () => ({ coolingLoss: 0, pduOff: false, netDown: false, sensorFault: false })

const emptyPoolFx = () => ({ down: false, apiDown: false, staleRate: 0, rejectRate: 0 })

function hostOf (url) {
  return String(url).replace(/^.*:\/\//, '').split(/[:/]/)[0]
}

class Simulation {
  constructor (cfg) {
    this.cfg = cfg
    const root = new Rng(cfg.seed)
    this.rngFleet = root.fork(1)
    this.rngTarget = root.fork(2)
    this.rngChaos = root.fork(3)
    this.env = new Environment(cfg.environment, root.fork(4), cfg.startHour)

    this.t = 0
    this.nextFaultId = 1
    this.nextGroupId = 1
    this.faults = []
    this.events = []
    this.eventSeq = 0
    this.scenario = null
    this.lastScenarioResult = null
    this.chaos = { ...cfg.chaos }
    this.siteFx = emptySiteFx()
    this.contractKw = cfg.grid.contractKw
    this.breakerKw = cfg.grid.breakerKw
    this.breakerOpen = false
    this.overBreakerSec = 0
    this.history = []
    this.dayIndex = 0

    this.site = { hashThs: 0, creditedThs: 0, powerKw: 0, itKw: 0, coolingKw: 0, overLimit: false, avgChipC: 0, maxChipC: 0 }
    this.economics = {
      energyKwh: 0,
      powerCostUsd: 0,
      revenueUsd: 0,
      penaltyUsd: 0,
      btcEarned: 0,
      overLimitKwh: 0,
      revenueRateUsdH: 0,
      costRateUsdH: 0
    }
    this.meterReading = { powerKw: 0, voltageV: cfg.grid.voltageV, powerFactor: cfg.grid.powerFactor }

    this._buildPools()
    this._buildFleet()
    this._settle()
    this.log('info', 'sim', `Site online: ${this.miners.length} miners in ${this.containers.length} containers`)
  }

  // A zero-length step fills in every derived value, so a new site reads
  // correctly before its first real step, even if it starts paused.
  _settle () {
    this.env.update(this.t, 0, this.siteFx)
    this._stepContainers(0, true)
    this._stepMiners(0, true)
    this._stepPower(0, true)
    this._stepPools(0)
    this._stepEconomics(0)
  }

  _buildPools () {
    const { primary, backup } = this.cfg.pools
    this.pools = new Map()
    this.poolHosts = new Map()
    this.poolUrlCache = new Map()
    for (const def of [primary, backup]) this._addPool(def)
    // Avalon's Worker pads unused slots with this placeholder, which never connects.
    this.poolHosts.set('dummy', null)
    this.poolHosts.set('', null)
  }

  _addPool (def) {
    const pool = {
      id: def.id,
      name: def.name,
      url: def.url,
      username: def.username,
      apiSecret: def.apiSecret || null,
      fx: emptyPoolFx(),
      creditedThs: 0,
      workers: 0,
      ema1h: 0,
      ema24h: 0,
      staleEma1h: 0,
      staleEma24h: 0,
      btcTotal: 0,
      btcPaid: 0,
      btcToday: 0,
      btcYesterday: 0,
      transactions: [],
      // Wall-clock history, because MDK's pool Worker queries by real time.
      samples: []
    }
    this.pools.set(pool.id, pool)
    for (const host of def.hosts || [hostOf(def.url)]) this.poolHosts.set(host, pool)
    return pool
  }

  poolForUrl (url) {
    if (this.poolUrlCache.has(url)) return this.poolUrlCache.get(url)
    const host = hostOf(url)
    let pool = this.poolHosts.get(host)
    if (pool === undefined) {
      // A pool the operator configured that the site has not seen yet. Past the
      // cap it behaves like an unreachable host, so a client can't grow this forever.
      pool = this.pools.size < MAX_POOLS
        ? this._addPool({ id: host, name: host, url, username: '', hosts: [host] })
        : null
    }
    this.poolUrlCache.set(url, pool)
    return pool
  }

  _buildFleet () {
    const { fleet, miner: shared, ports, cooling, pools } = this.cfg
    const poolList = [
      { url: pools.primary.url, user: `${pools.primary.username}.m` },
      { url: pools.backup.url, user: `${pools.backup.username}.m` },
      // The Avalon and Antminer firmwares always hold three slots.
      { url: 'stratum+tcp://dummy', user: 'dummy', password: 'dummy' }
    ]

    this.containers = []
    this.miners = []
    this.minerById = new Map()
    let index = 0
    for (let c = 0; c < fleet.containers; c++) {
      const id = `c${c + 1}`
      const container = {
        id,
        index: c,
        name: `Container ${c + 1}`,
        capacityKw: 0,
        sensorPort: ports.sensorBase + c,
        inletC: this.env.ambientC + cooling.approachC,
        exhaustC: this.env.ambientC + cooling.approachC,
        heatKw: 0,
        coolingKw: cooling.baseKw,
        fx: emptyContainerFx(),
        miners: []
      }
      this.containers.push(container)
      for (let m = 0; m < fleet.minersPerContainer; m++) {
        const minerId = `${id}-m${String(m + 1).padStart(3, '0')}`
        const spec = specFor(fleet.models[index], shared)
        container.capacityKw += spec.nominalW / 1000 * cooling.capacityFactor
        const miner = new Miner({
          id: minerId,
          index,
          containerId: id,
          port: ports.minerBase + index,
          serial: `${spec.id.slice(0, 2).toUpperCase()}${spec.name.replace(/\W/g, '')}${String(index + 1).padStart(9, '0')}`,
          spec,
          rng: this.rngFleet.fork(index + 100),
          pools: poolList.slice(0, spec.defaultPools).map((pool) => ({
            ...pool,
            user: pool.user === 'dummy' ? 'dummy' : `${pool.user}${String(index + 1).padStart(3, '0')}`
          }))
        })
        // Start warm and running, rather than making every run wait for a boot.
        miner.state = STATE.MINING
        miner.chipC = 66
        miner.ths = spec.nominalThs * miner.hashFactor
        miner.ema = { s30: miner.ths, m1: miner.ths, m5: miner.ths, m15: miner.ths }
        miner.chipW = spec.nominalW * miner.powerFactor
        miner.powerW = miner.chipW
        container.miners.push(miner)
        this.miners.push(miner)
        this.minerById.set(minerId, miner)
        index++
      }
    }
  }

  log (level, source, message, extra) {
    this.events.push({ seq: ++this.eventSeq, t: this.t, level, source, message, ...extra })
    if (this.events.length > MAX_EVENTS) this.events.shift()
  }

  // --- faults -------------------------------------------------------------

  // Expands 'all', 'random:N', 'percent:N', 'container:c1' or 'miner:id' into
  // the concrete targets a fault of the given scope applies to.
  resolveTargets (scope, target) {
    if (scope === 'site') return ['site']
    if (scope === 'pool') {
      const id = String(target || this.cfg.pools.primary.id).replace(/^pool:/, '')
      if (!this.pools.has(id)) throw new Error(`ERR_POOL_NOT_FOUND: ${id}`)
      return [id]
    }
    if (scope === 'container') {
      const value = String(target || 'c1')
      if (value === 'all') return this.containers.map((c) => c.id)
      if (value.startsWith('random')) return [this.rngTarget.pick(this.containers).id]
      const id = value.replace(/^container:/, '')
      if (!this.containers.some((c) => c.id === id)) throw new Error(`ERR_CONTAINER_NOT_FOUND: ${id}`)
      return [id]
    }

    const value = String(target || 'random:1')
    if (value === 'all') return this.miners.map((m) => m.id)
    if (value.startsWith('model:')) {
      const model = value.slice(6)
      if (!MODELS[model]) throw new Error(`ERR_MODEL_INVALID: ${model}`)
      return this.miners.filter((m) => m.model === model).map((m) => m.id)
    }
    if (value.startsWith('container:')) {
      const container = this.containers.find((c) => c.id === value.slice(10))
      if (!container) throw new Error(`ERR_CONTAINER_NOT_FOUND: ${value.slice(10)}`)
      return container.miners.map((m) => m.id)
    }
    if (value.startsWith('random:') || value.startsWith('percent:')) {
      const raw = Number(value.split(':')[1])
      if (!Number.isFinite(raw) || raw <= 0) throw new Error(`ERR_TARGET_INVALID: ${value}`)
      const count = value.startsWith('percent:') ? Math.ceil(this.miners.length * raw / 100) : Math.floor(raw)
      return this._sampleMiners(count).map((m) => m.id)
    }
    const id = value.replace(/^miner:/, '')
    if (!this.minerById.has(id)) throw new Error(`ERR_MINER_NOT_FOUND: ${id}`)
    return [id]
  }

  _sampleMiners (count) {
    const pool = this.miners.slice()
    const out = []
    while (out.length < count && pool.length) {
      const i = Math.floor(this.rngTarget.next() * pool.length)
      out.push(pool.splice(i, 1)[0])
    }
    return out
  }

  injectFault ({ type, target, params, durationSec, source = 'operator' }) {
    const def = CATALOG[type]
    if (!def) throw new Error(`ERR_FAULT_TYPE_INVALID: ${type}`)
    const resolved = resolveParams(type, params)
    const targets = this.resolveTargets(def.scope, target)
    const groupId = this.nextGroupId++
    const duration = Number(durationSec)
    const expiresAt = Number.isFinite(duration) && duration > 0 ? this.t + duration : null

    const created = targets.map((id) => {
      const fault = {
        id: this.nextFaultId++,
        groupId,
        type,
        label: def.label,
        scope: def.scope,
        target: id,
        params: resolved,
        source,
        startedAt: this.t,
        expiresAt
      }
      this.faults.push(fault)
      return fault
    })

    this._recomputeEffects()
    const where = def.scope === 'site' ? 'site' : targets.length === 1 ? targets[0] : `${targets.length} miners`
    this.log(def.scope === 'miner' ? 'warn' : 'error', source, `${def.label} on ${where}`)
    return created
  }

  clearFaults (predicate, source = 'operator') {
    const removed = this.faults.filter(predicate)
    if (!removed.length) return 0
    this.faults = this.faults.filter((fault) => !predicate(fault))
    this._recomputeEffects()
    const groups = new Set()
    for (const fault of removed) {
      if (groups.has(fault.groupId)) continue
      groups.add(fault.groupId)
      const count = removed.filter((f) => f.groupId === fault.groupId).length
      const where = fault.scope === 'site' ? 'site' : count === 1 ? fault.target : `${count} miners`
      this.log('info', source, `${fault.label} cleared on ${where}`)
    }
    return removed.length
  }

  _recomputeEffects () {
    this.siteFx = emptySiteFx()
    for (const container of this.containers) container.fx = emptyContainerFx()
    for (const miner of this.miners) miner.fx = emptyFx()
    for (const pool of this.pools.values()) pool.fx = emptyPoolFx()

    for (const fault of this.faults) {
      const { apply } = CATALOG[fault.type]
      if (fault.scope === 'site') apply(this.siteFx, fault.params)
      else if (fault.scope === 'pool') apply(this.pools.get(fault.target).fx, fault.params)
      else if (fault.scope === 'container') apply(this.containers.find((c) => c.id === fault.target).fx, fault.params)
      else apply(this.minerById.get(fault.target).fx, fault.params)
    }
    // A dead switch takes down every miner behind it.
    for (const container of this.containers) {
      if (!container.fx.netDown) continue
      for (const miner of container.miners) miner.fx.netDown = true
    }
  }

  _expireFaults () {
    if (this.faults.some((f) => f.expiresAt !== null && f.expiresAt <= this.t)) {
      this.clearFaults((f) => f.expiresAt !== null && f.expiresAt <= this.t, 'sim')
    }
  }

  _stepChaos (dt) {
    if (!this.chaos.enabled || !this.miners.length) return
    const expected = this.chaos.faultsPerMinerDay * this.miners.length * dt / DAY
    if (this.rngChaos.next() >= expected) return
    const total = CHAOS_TYPES.reduce((sum, [, weight]) => sum + weight, 0)
    let roll = this.rngChaos.next() * total
    const [type] = CHAOS_TYPES.find(([, weight]) => (roll -= weight) < 0) || CHAOS_TYPES[0]
    const miner = this.rngChaos.pick(this.miners)
    const [lo, hi] = this.chaos.repairHours
    this.injectFault({
      type,
      target: `miner:${miner.id}`,
      durationSec: this.rngChaos.range(lo, hi) * 3600,
      source: 'chaos'
    })
  }

  // --- commands -----------------------------------------------------------

  // `source` shows in the event log, so MDK's writes are visible as they land.
  minerCommand (id, action, value, source = 'operator') {
    const miner = this.minerById.get(id)
    if (!miner) throw new Error(`ERR_MINER_NOT_FOUND: ${id}`)
    switch (action) {
      case 'sleep':
        miner.suspended = true
        break
      case 'wake':
        miner.suspended = false
        break
      case 'reboot':
        this._rebootMiner(miner)
        break
      case 'mode': {
        const mode = Object.entries(this.cfg.miner.modes).find(([k, m]) => k === String(value) || m.name === value)
        if (!mode) throw new Error('ERR_MODE_INVALID')
        miner.workMode = Number(mode[0])
        break
      }
      case 'fan':
        if (value === null || value === 'auto') {
          miner.manualFanPct = null
        } else {
          const pct = Number(value)
          if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error('ERR_FAN_SPEED_INVALID')
          miner.manualFanPct = pct
        }
        break
      case 'led':
        miner.led = Boolean(value)
        break
      case 'powerPct': {
        const pct = Number(value)
        if (!Number.isFinite(pct) || pct < 10 || pct > 120) throw new Error('ERR_POWER_PCT_INVALID')
        miner.powerScale = pct / 100
        break
      }
      case 'repair':
        this.clearFaults((f) => f.scope === 'miner' && f.target === id, source)
        return
      default:
        throw new Error(`ERR_COMMAND_INVALID: ${action}`)
    }
    if (source !== 'quiet') {
      const detail = value === undefined || value === null ? '' : ` ${value}`
      this.log('info', source, `${action}${detail} on ${id}`)
    }
  }

  _rebootMiner (miner) {
    miner.boot(this.t, 'reboot')
    if (this.faults.some((f) => f.target === miner.id && CATALOG[f.type].clearedByReboot)) {
      this.clearFaults((f) => f.target === miner.id && CATALOG[f.type].clearedByReboot, 'sim')
    }
  }

  setMinerPools (id, pools, source = 'operator') {
    const miner = this.minerById.get(id)
    if (!miner) throw new Error(`ERR_MINER_NOT_FOUND: ${id}`)
    miner.setPools(pools)
    this.log('info', source, `pools set on ${id}: ${pools.map((pool) => pool.url).join(', ') || 'none'}`)
  }

  resetBreaker (source = 'operator') {
    if (!this.breakerOpen) return false
    this.breakerOpen = false
    this.overBreakerSec = 0
    this.log('info', source, 'Main breaker closed, fleet restarting')
    return true
  }

  setSite ({ contractKw, contractFactor, chaos }) {
    if (contractFactor !== undefined) {
      const factor = Number(contractFactor)
      if (!Number.isFinite(factor) || factor <= 0) throw new Error('ERR_CONTRACT_INVALID')
      contractKw = this.cfg.grid.contractKw * factor
    }
    if (contractKw !== undefined) {
      const value = Number(contractKw)
      if (!Number.isFinite(value) || value <= 0) throw new Error('ERR_CONTRACT_INVALID')
      this.contractKw = value
      this.breakerKw = Math.ceil(value * 1.25)
    }
    if (chaos !== undefined) {
      if (chaos.enabled !== undefined) {
        this.chaos.enabled = Boolean(chaos.enabled)
        this.log('info', 'operator', `Random failures ${this.chaos.enabled ? 'on' : 'off'}`)
      }
      if (chaos.faultsPerMinerDay !== undefined) {
        const rate = Number(chaos.faultsPerMinerDay)
        if (!Number.isFinite(rate) || rate < 0) throw new Error('ERR_CHAOS_RATE_INVALID')
        this.chaos.faultsPerMinerDay = rate
      }
    }
  }

  // --- scenarios ----------------------------------------------------------

  startScenario (scenario) {
    if (this.scenario) this.stopScenario('replaced')
    this.scenario = {
      def: scenario,
      startedAt: this.t,
      next: 0,
      baseline: { ...this.economics },
      contractKw: this.contractKw,
      breakerKw: this.breakerKw
    }
    this.lastScenarioResult = null
    this.log('info', 'scenario', `Started: ${scenario.name}`)
  }

  stopScenario (reason = 'stopped') {
    if (!this.scenario) return null
    const { def, baseline } = this.scenario
    const result = {
      id: def.id,
      name: def.name,
      reason,
      durationSec: this.t - this.scenario.startedAt,
      energyKwh: this.economics.energyKwh - baseline.energyKwh,
      btcEarned: this.economics.btcEarned - baseline.btcEarned,
      revenueUsd: this.economics.revenueUsd - baseline.revenueUsd,
      powerCostUsd: this.economics.powerCostUsd - baseline.powerCostUsd,
      penaltyUsd: this.economics.penaltyUsd - baseline.penaltyUsd,
      overLimitKwh: this.economics.overLimitKwh - baseline.overLimitKwh
    }
    result.profitUsd = result.revenueUsd - result.powerCostUsd - result.penaltyUsd
    this.lastScenarioResult = result
    this.contractKw = this.scenario.contractKw
    this.breakerKw = this.scenario.breakerKw
    this.scenario = null
    this.clearFaults((f) => f.source === 'scenario', 'scenario')
    this.log('info', 'scenario', `${def.name} ${reason}: profit $${result.profitUsd.toFixed(2)}, penalties $${result.penaltyUsd.toFixed(2)}`)
    return result
  }

  _stepScenario () {
    if (!this.scenario) return
    const { def, startedAt } = this.scenario
    const elapsed = this.t - startedAt
    while (this.scenario.next < def.events.length && def.events[this.scenario.next].at <= elapsed) {
      const event = def.events[this.scenario.next++]
      try {
        this._runScenarioEvent(event)
      } catch (err) {
        this.log('error', 'scenario', `Step failed: ${err.message}`)
      }
    }
    if (elapsed >= def.durationSec) this.stopScenario('finished')
  }

  _runScenarioEvent (event) {
    switch (event.action) {
      case 'fault':
        this.injectFault({ ...event, source: 'scenario' })
        break
      case 'clear':
        this.clearFaults((f) => f.source === 'scenario' && (!event.type || f.type === event.type), 'scenario')
        break
      case 'command': {
        const targets = this.resolveTargets('miner', event.target || 'all')
        for (const id of targets) this.minerCommand(id, event.command, event.value, 'quiet')
        this.log('info', 'scenario', `${event.command}${event.value === undefined ? '' : ` ${event.value}`} on ${targets.length} miners`)
        break
      }
      case 'set':
        this.setSite(event)
        break
      case 'resetBreaker':
        this.resetBreaker('scenario')
        break
      case 'note':
        this.log(event.level || 'info', 'scenario', event.message)
        break
    }
  }

  // --- the model ----------------------------------------------------------

  step (dt = 1) {
    this.t += dt
    this._expireFaults()
    this._stepScenario()
    this._stepChaos(dt)
    this.env.update(this.t, dt, this.siteFx)

    const powered = !this.siteFx.gridDown && !this.breakerOpen
    this._stepContainers(dt, powered)
    this._stepMiners(dt, powered)
    this._stepPower(dt, powered)
    this._stepPools(dt)
    this._stepEconomics(dt)
    this._stepDayRollover()
    if (this.t % this.cfg.history.sampleSec < dt) this._sample()
  }

  _stepContainers (dt, powered) {
    const { cooling } = this.cfg
    const ambient = this.env.ambientC
    const blend = 1 - Math.exp(-dt / cooling.tauSec)

    for (const container of this.containers) {
      let heatW = 0
      for (const miner of container.miners) heatW += miner.powerW
      container.heatKw = heatW / 1000

      const derate = 1 - Math.max(0, ambient - cooling.derateAboveC) * cooling.deratePerC
      const running = powered && !container.fx.pduOff
      const available = container.capacityKw * Math.max(0.02, (1 - container.fx.coolingLoss) * Math.max(0.2, derate))
      const load = container.heatKw / available
      const overload = Math.min(cooling.maxOverload, Math.max(0, load - 1))
      const target = ambient + cooling.approachC + cooling.loadRiseC * Math.min(load, 1) + cooling.overloadRiseC * overload

      container.availableKw = available
      container.inletC += (target - container.inletC) * blend
      container.exhaustC = container.inletC + (container.miners.length ? (container.heatKw / container.miners.length) * 8 : 0)
      container.coolingKw = running ? (cooling.baseKw + container.heatKw * cooling.powerFraction) * (1 - container.fx.coolingLoss * 0.7) : 0
    }
  }

  _stepMiners (dt, powered) {
    let hash = 0
    let it = 0
    let chipSum = 0
    let chipMax = 0
    for (const container of this.containers) {
      const feed = powered && !container.fx.pduOff
      for (const miner of container.miners) {
        const event = miner.step(this.t, dt, container.inletC, feed)
        if (event) this.log(event.level, 'miner', event.message, { minerId: miner.id })
        hash += miner.ths
        it += miner.powerW
        chipSum += miner.chipC
        if (miner.chipC > chipMax) chipMax = miner.chipC
        if (this.t % 60 < dt) miner.sample(this.t)
      }
    }
    this.site.hashThs = hash
    this.site.itKw = it / 1000
    this.site.avgChipC = chipSum / this.miners.length
    this.site.maxChipC = chipMax
  }

  _stepPower (dt, powered) {
    const { grid } = this.cfg
    let coolingKw = 0
    for (const container of this.containers) coolingKw += container.coolingKw
    const powerKw = this.site.itKw + coolingKw
    const limitKw = this.contractKw * this.siteFx.limitFactor

    Object.assign(this.site, { coolingKw, powerKw, limitKw, overLimit: powered && powerKw > limitKw })

    if (powerKw > this.breakerKw) {
      this.overBreakerSec += dt
      if (this.overBreakerSec >= grid.breakerTripSec && !this.breakerOpen) {
        this.breakerOpen = true
        this.log('error', 'grid', `Main breaker opened after ${grid.breakerTripSec}s above ${this.breakerKw} kW. It needs a manual reset.`)
      }
    } else {
      this.overBreakerSec = 0
    }

    if (!this.siteFx.meterFrozen) {
      const live = !this.siteFx.gridDown && !this.breakerOpen
      this.meterReading = {
        powerKw,
        voltageV: live ? grid.voltageV * (1 - 0.01 * Math.min(1, powerKw / this.contractKw)) : 0,
        powerFactor: grid.powerFactor
      }
    }
  }

  _stepPools (dt) {
    const { pools: cfg } = this.cfg
    const pools = [...this.pools.values()]
    for (const pool of pools) {
      pool.creditedThs = 0
      pool.workers = 0
      pool.staleThs = 0
    }

    let credited = 0
    const btcPerThSec = this.env.btcPerThDay / DAY
    let btcEarned = 0

    for (const miner of this.miners) {
      miner.activePool = -1
      miner.creditedThs = 0
      if (!miner.fx.netDown && miner.state !== STATE.OFF && miner.state !== STATE.BOOTING) {
        for (let i = 0; i < miner.pools.length; i++) {
          const pool = this.poolForUrl(miner.pools[i].url)
          if (pool && !pool.fx.down) {
            miner.activePool = i
            miner._poolRef = pool
            break
          }
        }
      }
      if (miner.activePool < 0 || miner.ths <= 0) continue

      const pool = miner._poolRef
      const staleRate = cfg.baseStaleRate + pool.fx.staleRate
      const rejectRate = cfg.baseRejectRate + pool.fx.rejectRate
      miner.creditShares(dt, cfg.shareDifficulty, staleRate, rejectRate)

      const creditedThs = miner.ths * (1 - staleRate - rejectRate)
      miner.creditedThs = creditedThs
      pool.creditedThs += creditedThs
      pool.staleThs += miner.ths * staleRate
      pool.workers++
      credited += creditedThs

      const btc = creditedThs * btcPerThSec * dt * (1 - cfg.feeRate)
      pool.btcTotal += btc
      pool.btcToday += btc
      btcEarned += btc
    }

    const blend1h = 1 - Math.exp(-dt / 3600)
    const blend24h = 1 - Math.exp(-dt / DAY)
    for (const pool of pools) {
      pool.ema1h += (pool.creditedThs - pool.ema1h) * blend1h
      pool.ema24h += (pool.creditedThs - pool.ema24h) * blend24h
      pool.staleEma1h += (pool.staleThs - pool.staleEma1h) * blend1h
      pool.staleEma24h += (pool.staleThs - pool.staleEma24h) * blend24h
    }

    this.site.creditedThs = credited
    this._btcThisStep = btcEarned
  }

  _stepEconomics (dt) {
    const { economics: eco, site, env } = this
    const energy = site.powerKw * dt / 3600
    const over = site.overLimit ? (site.powerKw - site.limitKw) * dt / 3600 : 0
    eco.energyKwh += energy
    eco.powerCostUsd += energy * env.priceUsdKwh
    eco.overLimitKwh += over
    eco.penaltyUsd += over * this.cfg.grid.penaltyUsdKwh
    eco.btcEarned += this._btcThisStep
    eco.revenueUsd += this._btcThisStep * env.btcUsd
    eco.revenueRateUsdH = (site.creditedThs * env.btcPerThDay * (1 - this.cfg.pools.feeRate) / 24) * env.btcUsd
    eco.costRateUsdH = site.powerKw * env.priceUsdKwh
  }

  // At simulated midnight the pool settles the day, as an FPPS payout would.
  _stepDayRollover () {
    const hours = this.cfg.startHour + this.t / 3600
    const day = Math.floor(hours / 24)
    if (day === this.dayIndex) return
    this.dayIndex = day
    for (const pool of this.pools.values()) {
      if (pool.btcToday > 0) {
        pool.transactions.push({
          id: 100000000 + pool.transactions.length,
          type: 'revenue_fpps',
          changed_balance: pool.btcToday,
          created_at: Math.floor(Date.now() / 1000),
          mining_extra: {
            mining_date: Math.floor(Date.now() / 1000),
            settle_date: Math.floor(Date.now() / 1000),
            pps: pool.btcToday,
            pps_fee_rate: this.cfg.pools.feeRate,
            tx_fee: 0,
            tx_fee_rate: 0,
            hash_rate: pool.ema24h * 1e12
          },
          payout_extra: null
        })
        pool.btcPaid = pool.btcTotal
      }
      pool.btcYesterday = pool.btcToday
      pool.btcToday = 0
    }
    this.log('info', 'pool', `Day ${day + 1} started, yesterday's earnings settled`)
  }

  _sample () {
    const { site, env, economics } = this
    this.history.push({
      t: this.t,
      hash: site.hashThs,
      credited: site.creditedThs,
      power: site.powerKw,
      limit: site.limitKw,
      ambient: env.ambientC,
      inlet: this.containers.reduce((max, c) => Math.max(max, c.inletC), -100),
      chipAvg: site.avgChipC,
      chipMax: site.maxChipC,
      price: env.priceUsdKwh,
      revenueRate: economics.revenueRateUsdH,
      costRate: economics.costRateUsdH,
      profit: economics.revenueUsd - economics.powerCostUsd - economics.penaltyUsd
    })
    if (this.history.length > this.cfg.history.maxSamples) this.history.shift()
  }

  // Keeps the buckets aligned to the clock and averages each one, so a short
  // spike survives downsampling and points don't shift as new samples arrive.
  historyWindow (windowSec, points = 480) {
    const from = windowSec ? this.t - windowSec : 0
    const samples = this.history.filter((sample) => sample.t >= from)
    if (samples.length <= points) return samples
    const span = Math.max(1, this.t - samples[0].t)
    const width = Math.max(this.cfg.history.sampleSec, Math.ceil(span / points / this.cfg.history.sampleSec) * this.cfg.history.sampleSec)
    const out = []
    let bucket = null
    let count = 0
    let key = null
    const flush = () => {
      if (!bucket) return
      for (const name of Object.keys(bucket)) {
        if (name === 'chipMax') continue
        if (name !== 't' && name !== 'profit') bucket[name] /= count
      }
      out.push(bucket)
    }
    for (const sample of samples) {
      const k = Math.floor(sample.t / width)
      if (k !== key) {
        flush()
        key = k
        bucket = { ...sample }
        count = 1
        continue
      }
      for (const name of Object.keys(sample)) {
        if (name === 't' || name === 'profit') bucket[name] = sample[name]
        else if (name === 'chipMax') bucket[name] = Math.max(bucket[name], sample[name])
        else bucket[name] += sample[name]
      }
      count++
    }
    flush()
    return out
  }

  // --- views --------------------------------------------------------------

  clock () {
    const total = this.cfg.startHour * 3600 + this.t
    const day = Math.floor(total / DAY) + 1
    const left = total % DAY
    const hour = Math.floor(left / 3600)
    const minute = Math.floor((left % 3600) / 60)
    return { day, hour, minute, elapsedSec: this.t, startHour: this.cfg.startHour }
  }

  fleetCounts () {
    const counts = { mining: 0, sleeping: 0, booting: 0, off: 0, tripped: 0, failed: 0, unreachable: 0 }
    for (const miner of this.miners) {
      counts[miner.state]++
      if (!miner.reachable) counts.unreachable++
    }
    return counts
  }

  snapshot ({ eventsAfter = 0 } = {}) {
    const { site, env, economics } = this
    return {
      t: this.t,
      clock: this.clock(),
      site: {
        ...site,
        contractKw: this.contractKw,
        breakerKw: this.breakerKw,
        breakerTripSec: this.cfg.grid.breakerTripSec,
        breakerOpen: this.breakerOpen,
        overBreakerSec: this.overBreakerSec,
        gridDown: this.siteFx.gridDown,
        gridAlert: this.siteFx.gridAlert,
        voltageV: this.meterReading.voltageV,
        counts: this.fleetCounts()
      },
      env: {
        ambientC: env.ambientC,
        priceUsdKwh: env.priceUsdKwh,
        btcUsd: env.btcUsd,
        hashpriceUsdThDay: env.hashpriceUsdThDay
      },
      economics: {
        ...economics,
        profitUsd: economics.revenueUsd - economics.powerCostUsd - economics.penaltyUsd,
        profitRateUsdH: economics.revenueRateUsdH - economics.costRateUsdH
      },
      containers: this.containers.map((c) => ({
        id: c.id,
        name: c.name,
        inletC: c.inletC,
        exhaustC: c.exhaustC,
        heatKw: c.heatKw,
        capacityKw: c.capacityKw,
        availableKw: c.availableKw || c.capacityKw,
        coolingKw: c.coolingKw,
        fx: c.fx
      })),
      pools: [...this.pools.values()].map((p) => ({
        id: p.id,
        name: p.name,
        url: p.url,
        down: p.fx.down,
        apiDown: p.fx.apiDown,
        degraded: p.fx.staleRate > 0 || p.fx.rejectRate > 0,
        creditedThs: p.creditedThs,
        workers: p.workers,
        btcTotal: p.btcTotal,
        hasApi: Boolean(p.apiSecret)
      })),
      miners: this.miners.map((miner) => miner.view()),
      faults: this.faults,
      chaos: this.chaos,
      scenario: this.scenario && {
        id: this.scenario.def.id,
        name: this.scenario.def.name,
        goal: this.scenario.def.goal,
        elapsedSec: this.t - this.scenario.startedAt,
        durationSec: this.scenario.def.durationSec
      },
      scenarioResult: this.lastScenarioResult,
      events: this.events.filter((event) => event.seq > eventsAfter).slice(-200)
    }
  }

  minerDetail (id) {
    const miner = this.minerById.get(id)
    if (!miner) throw new Error(`ERR_MINER_NOT_FOUND: ${id}`)
    return {
      ...miner.view(),
      brand: miner.spec.brand,
      modelName: miner.spec.name,
      protocol: miner.spec.protocol,
      powerPct: Math.round(miner.powerScale * 100),
      serial: miner.serial,
      port: miner.port,
      address: this.cfg.host,
      inletC: miner.inletC,
      bootLeft: miner.bootLeft,
      uptimeSec: miner.reachable ? this.t - miner.bootedAt : 0,
      efficiency: miner.ths > 1 ? miner.powerW / miner.ths : null,
      manualFanPct: miner.manualFanPct,
      suspended: miner.suspended,
      hwErrors: Math.floor(miner.hwErrors),
      lastBootReason: miner.lastBootReason,
      pools: miner.pools.map((pool, index) => ({
        url: pool.url,
        user: pool.user,
        accepted: pool.accepted,
        rejected: pool.rejected,
        stale: pool.stale,
        active: index === miner.activePool
      })),
      history: miner.history,
      faults: this.faults.filter((fault) => fault.target === id)
    }
  }
}

module.exports = Simulation
