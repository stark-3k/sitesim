'use strict'

// An MDK app that lowers a site's power when it has to, and brings it back carefully.
//
// It responds to a site power cap, a utility's limit, a price that makes mining
// unprofitable, and grid alerts. Miners go to eco mode first, and to sleep if that
// isn't enough. It reads power and commands miners only through MDK. Prices, limits
// and alerts come from `getSignals`, because none of those are MDK devices.

const { commandFor } = require('./normalize')

const MINUTE = 60000

const DEFAULTS = {
  tickMs: 3000,
  marginKw: 15,
  // How quickly the estimate of non-miner load follows the meter.
  overheadBlend: 0.1,
  // How long to wait for a command to show in telemetry before trying again.
  pendingMs: 30000,
  pullConcurrency: 16,
  // A read can hang while a device goes down, and shedding mustn't wait for it.
  readTimeoutMs: 5000,
  poolFee: 0.02,
  // What eco mode is expected to do. Only a forecast: the next reading corrects it.
  ecoPower: 0.65,
  ecoHash: 0.8,
  // The price has to pass a threshold for this long, which ignores brief noise...
  priceConfirmMs: 5 * MINUTE,
  // ...and to fall this far below it before miners return.
  priceBand: 0.1,
  // How long things have to stay calm before any miner returns.
  clearHoldMs: 15 * MINUTE,
  alertHoldMs: 30 * MINUTE,
  // Each step of the return: its size (default a tenth of the fleet) and spacing.
  rampStepKw: null,
  rampIntervalMs: 5 * MINUTE,
  // Reasons to stop returning miners.
  rampMaxChipC: 88,
  rampMinSeen: 0.9,
  // After this long, a miner that hasn't come back is reported instead of awaited.
  rampTimeoutMs: 10 * MINUTE
}

const ASLEEP = new Set(['sleeping', 'suspended'])
const LOG_LINES = 12

const LEVEL = { NORMAL: 0, ECO: 1, SLEEP: 2 }

// Machines drawing power for no hashrate go first: they earn nothing at all.
function wasteRank (miner) {
  if (miner.hashThs <= 0) return Infinity
  return miner.powerW / miner.hashThs
}

// The power price above which this miner loses money. Revenue per kWh, allowing for
// the site's non-miner load, such as cooling, that its power brings with it.
function breakevenPrice ({ kw, ths }, hashpriceUsdThDay, overheadShare = 0, poolFee = DEFAULTS.poolFee) {
  if (!(kw > 0)) return Infinity
  return (ths * hashpriceUsdThDay * (1 - poolFee) / 24) / (kw * (1 + overheadShare))
}

// Over break-even, normal mining loses money and eco loses less. Eco earns more per
// kWh, so it stays profitable a little higher. Past that, sleeping loses least.
function priceLevelFor (price, breakeven, { ecoPower = DEFAULTS.ecoPower, ecoHash = DEFAULTS.ecoHash } = {}) {
  if (price > breakeven * (ecoHash / ecoPower)) return LEVEL.SLEEP
  if (price > breakeven) return LEVEL.ECO
  return LEVEL.NORMAL
}

// Moves a miner's price level on, given how long the price has been past a threshold.
// Up takes a short confirmation, and down takes a long hold and a margin as well.
function nextPriceLevel (entry, price, breakeven, now, opts) {
  const { priceConfirmMs, clearHoldMs, priceBand } = opts
  const up = priceLevelFor(price, breakeven, opts)
  const down = priceLevelFor(price * (1 + priceBand), breakeven, opts)
  const next = { ...entry }
  if (up > entry.level) {
    next.aboveSince ??= now
    next.belowSince = null
    if (now - next.aboveSince >= priceConfirmMs) Object.assign(next, { level: up, aboveSince: null })
  } else if (down < entry.level) {
    next.belowSince ??= now
    next.aboveSince = null
    if (now - next.belowSince >= clearHoldMs) Object.assign(next, { level: down, belowSince: null })
  } else {
    next.aboveSince = null
    next.belowSince = null
  }
  return next
}

/**
 * Decides what to do this tick. Pure, so the policy is testable without MDK.
 *
 * @param {object} input
 * @param {number} input.powerKw measured site power
 * @param {number} input.limitKw allowed site power
 * @param {number} input.marginKw headroom to keep below the limit
 * @param {object[]} input.miners { id, asleep, powerW, hashThs, canThrottle? }
 * @param {Map} input.slept id to { kw, rank }: miners this app put to sleep
 * @param {Map} input.pending id to { action, kw }: commands not yet confirmed
 * @param {Map} [input.throttled] id to { kw, rank }: miners this app put in eco mode
 * @param {Map} [input.floors] id to the lowest level price and alerts allow for now
 * @param {number} [input.rampKw] the most power to bring back in this step
 * @param {boolean} [input.rampOpen] whether anything may be brought back now
 * @param {number} [input.ecoPower] the share of its power a miner draws in eco mode
 * @returns {{ throttle: string[], sleep: string[], wake: string[], restore: string[] }}
 */
function plan ({ powerKw, limitKw, marginKw, miners, slept, pending, throttled = new Map(), floors = new Map(), rampKw = Infinity, rampOpen = true, ecoPower = DEFAULTS.ecoPower }) {
  let projected = powerKw
  for (const { action, kw } of pending.values()) projected += action === 'sleep' || action === 'throttle' ? -kw : kw

  const target = limitKw - marginKw
  const throttle = new Set()
  const sleep = new Set()
  const wake = []
  const restore = []
  const free = (m) => !pending.has(m.id)
  const awake = miners.filter((m) => !m.asleep && free(m) && m.powerW > 0)
    .sort((a, b) => wasteRank(b) - wasteRank(a) || a.id.localeCompare(b.id))
  const canThrottle = (m) => m.canThrottle && !throttled.has(m.id) && !throttle.has(m.id)
  const toEco = (m) => {
    throttle.add(m.id)
    projected -= (m.powerW / 1000) * (1 - ecoPower)
  }
  const toSleep = (m) => {
    // A miner just sent to eco is forecast at its eco power, so don't count that twice.
    projected -= (m.powerW / 1000) * (throttle.delete(m.id) ? ecoPower : 1)
    sleep.add(m.id)
  }

  // Price and alerts come first: they apply whatever the power is.
  for (const m of awake) {
    const floor = floors.get(m.id) ?? LEVEL.NORMAL
    if (floor >= LEVEL.SLEEP) toSleep(m)
    else if (floor === LEVEL.ECO && canThrottle(m)) toEco(m)
  }

  if (projected > target) {
    // Eco first, because it keeps most of the hashrate. Sleep only if that's not enough.
    for (const m of awake) {
      if (projected <= target) break
      if (canThrottle(m) && !sleep.has(m.id)) toEco(m)
    }
    for (const m of awake) {
      if (projected <= target) break
      if (!sleep.has(m.id)) toSleep(m)
    }
  } else if (rampOpen && !sleep.size && !throttle.size) {
    // Bringing back needs a full margin to spare, so the fleet doesn't flip back and forth.
    const room = target - marginKw
    let left = rampKw
    const fits = (kw) => projected + kw <= room && kw <= left
    const take = (kw) => {
      projected += kw
      left -= kw
    }

    const sleepers = miners
      .filter((m) => m.asleep && slept.has(m.id) && free(m) && (floors.get(m.id) ?? 0) < LEVEL.SLEEP)
      .sort((a, b) => (slept.get(a.id).rank - slept.get(b.id).rank) || a.id.localeCompare(b.id))
    let blocked = false
    for (const m of sleepers) {
      const { kw } = slept.get(m.id)
      if (!fits(kw)) {
        blocked = true
        break
      }
      wake.push(m.id)
      take(kw)
    }

    // Sleepers first: a kWh earns more in a miner on eco than one extra in normal mode.
    if (!blocked) {
      const inEco = miners
        .filter((m) => !m.asleep && throttled.has(m.id) && free(m) && (floors.get(m.id) ?? 0) < LEVEL.ECO)
        .sort((a, b) => (throttled.get(a.id).rank - throttled.get(b.id).rank) || a.id.localeCompare(b.id))
      for (const m of inEco) {
        const kw = Math.max(0, throttled.get(m.id).kw - m.powerW / 1000)
        if (!fits(kw)) break
        restore.push(m.id)
        take(kw)
      }
    }
  }
  return { throttle: [...throttle], sleep: [...sleep], wake, restore }
}

// SealMiner's firmware wakes with `resume`, and everything else with a mode change.
function wakeCommand (brand) {
  return brand === 'sealminer' ? ['resume', {}] : ['setPowerMode', { mode: 'normal' }]
}

class CurtailmentResponder {
  /**
   * @param {object} opts
   * @param {object} opts.client MDK client
   * @param {object[]} opts.miners { id, brand } for each miner
   * @param {string} opts.meterId the site's power meter device
   * @param {function} opts.getSignals async, returns what MDK can't report:
   *   { limitKw, priceUsdKwh?, hashpriceUsdThDay?, gridAlert?, nowMs? }. Give `nowMs`
   *   when the site's clock isn't real time, as in a simulation running fast.
   * @param {number} [opts.capKw] the site's own power cap, on top of any utility limit
   * @param {function} [opts.log]
   */
  constructor (opts) {
    Object.assign(this, DEFAULTS, opts)
    this.onLog = opts.log || (() => {})
    this.slept = new Map()
    this.throttled = new Map()
    this.pending = new Map()
    this.returning = new Map()
    this.profiles = new Map()
    this.priceLevels = new Map()
    this.notBack = new Set()
    this.brands = new Map(this.miners.map((m) => [m.id, m.brand]))
    this.recent = []
    this.rejected = 0
    this.steps = 0
    this.overheadKw = null
    this.signals = null
    this.signalsLost = false
    this.lastLimit = null
    this.lastNow = null
    this.summary = null
    this._resetTimers()
  }

  _resetTimers () {
    this.lastAlertAt = -Infinity
    this.lastGridDownAt = -Infinity
    this.lastShedAt = -Infinity
    this.lastLimitRiseAt = -Infinity
    this.lastRampAt = -Infinity
    this.priceLevels.clear()
  }

  log (message) {
    this.recent.push({ at: Date.now(), message })
    if (this.recent.length > LOG_LINES) this.recent.shift()
    this.onLog(message)
  }

  // Changes the site's own cap while running. Null removes it.
  setCap (capKw) {
    if (capKw !== null && !(Number.isFinite(capKw) && capKw > 0)) throw new Error('The cap has to be a positive number of kW, or null for none.')
    if (capKw !== this.capKw) this.log(capKw === null ? 'Site power cap removed' : `Site power cap set to ${capKw.toFixed(0)} kW`)
    this.capKw = capKw
  }

  async _pull (id) {
    let timer
    try {
      const telemetry = await Promise.race([
        this.client.pullTelemetry(id, 'metrics'),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('ERR_READ_TIMEOUT')), this.readTimeoutMs)
        })
      ])
      return telemetry.metrics || telemetry
    } finally {
      clearTimeout(timer)
    }
  }

  async _readMiners () {
    const out = []
    let next = 0
    const workers = Array.from({ length: this.pullConcurrency }, async () => {
      while (next < this.miners.length) {
        const miner = this.miners[next++]
        try {
          const m = await this._pull(miner.id)
          // A Worker that can't reach its device answers with errors in every field.
          if (typeof m.status !== 'string') continue
          out.push({
            id: miner.id,
            brand: miner.brand,
            asleep: ASLEEP.has(m.status),
            powerW: Number(m.power) || 0,
            hashThs: Number(m.hashrate_rt ?? m.hashrate_avg) || 0,
            chipC: Number(m.temperature) || 0,
            canThrottle: this.throttle !== false && Boolean(commandFor(miner.brand, 'mode', 'eco'))
          })
        } catch {
          // Unreachable this tick: it can't be commanded, and is left out.
        }
      }
    })
    await Promise.all(workers)
    return out
  }

  // Meters can be coarse: a SATEC register step is about 21.7 kW, so shedding one
  // miner may not move the reading at all. The miners' own power responds at once,
  // so that drives decisions. The meter only teaches us the load they don't report,
  // such as cooling, averaged so that its steps don't read as real changes.
  async _estimatePower (miners, now) {
    const minersKw = miners.reduce((sum, m) => sum + m.powerW, 0) / 1000
    try {
      const { active_power: watts, voltage } = await this._pull(this.meterId)
      // Zero volts means the supply is gone, which only a meter can say.
      if (voltage === 0) this.lastGridDownAt = now
      else if (typeof watts === 'number') {
        const overhead = watts / 1000 - minersKw
        this.overheadKw = this.overheadKw === null
          ? overhead
          : this.overheadKw + (overhead - this.overheadKw) * this.overheadBlend
      }
    } catch {
      // Carry on with the last estimate.
    }
    return minersKw + Math.max(0, this.overheadKw ?? 0)
  }

  // Signals that stop arriving are held at their last values. Shedding carries on from
  // those, and nothing comes back until they return.
  async _readSignals () {
    try {
      this.signals = await this.getSignals()
      if (this.signalsLost) this.log('Signals are back')
      this.signalsLost = false
    } catch (err) {
      if (!this.signalsLost) this.log(`Signals lost, so holding what's shed: ${err.message}`)
      this.signalsLost = true
    }
    return this.signals ?? {}
  }

  _learnProfiles (miners) {
    for (const m of miners) {
      if (m.asleep || m.hashThs <= 0 || m.powerW <= 0 || this.throttled.has(m.id) || this.pending.has(m.id)) continue
      // The best hashrate seen, so a fault can't make a miner look unprofitable. This
      // app sheds for money and power, and repairing miners is a different job.
      const known = this.profiles.get(m.id)
      this.profiles.set(m.id, { kw: m.powerW / 1000, ths: Math.max(known?.ths ?? 0, m.hashThs) })
    }
  }

  _overheadShare () {
    const minersKw = [...this.profiles.values()].reduce((sum, p) => sum + p.kw, 0)
    return minersKw > 0 ? Math.max(0, this.overheadKw ?? 0) / minersKw : 0
  }

  // The lowest level each miner may run at right now, from price and grid alerts.
  _floors (signals, now) {
    const floors = new Map()
    const { priceUsdKwh: price, hashpriceUsdThDay: hashprice, gridAlert } = signals
    const share = this._overheadShare()
    for (const { id } of this.miners) {
      let level = gridAlert ? LEVEL.ECO : LEVEL.NORMAL
      const profile = this.profiles.get(id)
      if (profile && Number.isFinite(price) && Number.isFinite(hashprice)) {
        const entry = this.priceLevels.get(id) ?? { level: LEVEL.NORMAL, aboveSince: null, belowSince: null }
        const breakeven = breakevenPrice(profile, hashprice, share, this.poolFee)
        const next = nextPriceLevel(entry, price, breakeven, now, this)
        this.priceLevels.set(id, next)
        level = Math.max(level, next.level)
      }
      if (level) floors.set(id, level)
    }
    return floors
  }

  _settle (miners, now) {
    const byId = new Map(miners.map((m) => [m.id, m]))
    for (const [id, entry] of this.pending) {
      const miner = byId.get(id)
      let done = false
      if (miner && entry.action === 'sleep') done = miner.asleep
      if (miner && entry.action === 'throttle') done = miner.powerW <= entry.fromW * 0.9
      if (miner && entry.action === 'restore') done = miner.powerW >= entry.fromW * 1.1
      if (done || Date.now() - entry.at > this.pendingMs) this.pending.delete(id)
    }
    for (const [id, entry] of this.returning) {
      const miner = byId.get(id)
      if (miner && !miner.asleep && miner.hashThs > 0) {
        this.returning.delete(id)
      } else if (now - entry.at > this.rampTimeoutMs && Date.now() - entry.sentAt > this.pendingMs) {
        // Real time as well, since a simulation's clock can outrun a Worker's cache.
        this.returning.delete(id)
        this.notBack.add(id)
        this.log(`${id} hasn't come back after waking, and needs a look`)
      }
    }
    for (const id of this.notBack) {
      if (byId.get(id)?.hashThs > 0) this.notBack.delete(id)
    }
    // Woken by someone else, or the sleep never took. Either way it's awake.
    for (const id of this.slept.keys()) {
      const miner = byId.get(id)
      if (miner && !miner.asleep && !this.pending.has(id)) this.slept.delete(id)
    }
  }

  // Why nothing may come back right now, or null if it may.
  _rampBlock (signals, miners, now) {
    if (signals.gridAlert) return 'grid alert active'
    if (this.signalsLost) return 'signals lost'
    if (now === this.lastGridDownAt) return 'no grid power'
    const seen = miners.length / this.miners.length
    if (seen < this.rampMinSeen) return `only ${miners.length} of ${this.miners.length} miners answering`
    const hottest = miners.reduce((max, m) => Math.max(max, m.chipC), 0)
    if (hottest >= this.rampMaxChipC) return `hottest chip at ${hottest.toFixed(0)}°C`
    if (this.returning.size) return `waiting for ${this.returning.size} to come back`
    const holds = [
      [this.lastAlertAt + this.alertHoldMs, 'after the grid alert'],
      [this.lastGridDownAt + this.alertHoldMs, 'after the outage'],
      [this.lastShedAt + this.clearHoldMs, 'after shedding'],
      [this.lastLimitRiseAt + this.clearHoldMs, 'after the limit rose'],
      [this.lastRampAt + this.rampIntervalMs, 'until the next step']
    ]
    for (const [until, why] of holds) {
      if (now < until) return `holding ${why}, ${Math.ceil((until - now) / MINUTE)} min`
    }
    return null
  }

  _rampStepKw () {
    if (this.rampStepKw !== null) return this.rampStepKw
    let fleetKw = 0
    for (const { id } of this.miners) fleetKw += this.profiles.get(id)?.kw ?? 0
    return Math.max(fleetKw / 10, ...[...this.profiles.values()].map((p) => p.kw))
  }

  async _send (id, action, kw, fromW) {
    const brand = this.brands.get(id)
    const [command, params] = {
      sleep: () => ['setPowerMode', { mode: 'sleep' }],
      wake: () => wakeCommand(brand),
      throttle: () => commandFor(brand, 'mode', 'eco'),
      restore: () => commandFor(brand, 'mode', 'normal')
    }[action]()
    try {
      const res = await this.client.sendCommand(id, command, params)
      if (res?.status === 'REJECTED') throw new Error(res.error)
      if (action !== 'wake') this.pending.set(id, { action, kw, fromW, at: Date.now() })
      return true
    } catch (err) {
      this.rejected++
      this.log(`${action} failed on ${id}: ${err.message}`)
      return false
    }
  }

  _noteSignals (signals, targetLimit, now) {
    if (this.lastNow !== null && now < this.lastNow) this._resetTimers()
    this.lastNow = now
    if (signals.gridAlert) {
      if (!this.alerting) this.log('Grid alert: dropping to eco, and holding any return')
      this.lastAlertAt = now
    } else if (this.alerting) {
      this.log('Grid alert over')
    }
    this.alerting = Boolean(signals.gridAlert)
    if (targetLimit !== this.lastLimit) {
      if (this.lastLimit !== null) {
        if (targetLimit > this.lastLimit) this.lastLimitRiseAt = now
        this.log(`Power limit changed: ${this.lastLimit.toFixed(0)} kW to ${targetLimit.toFixed(0)} kW`)
      }
      this.lastLimit = targetLimit
    }
  }

  async tick () {
    const signals = await this._readSignals()
    const now = signals.nowMs ?? Date.now()
    const limitKw = Math.min(signals.limitKw ?? Infinity, this.capKw ?? Infinity)
    this._noteSignals(signals, limitKw, now)

    const miners = await this._readMiners()
    const powerKw = await this._estimatePower(miners, now)
    this._learnProfiles(miners)
    this._settle(miners, now)

    const floors = this._floors(signals, now)
    const rampBlock = this._rampBlock(signals, miners, now)
    // Nothing can act without power, and the miners restart by themselves.
    const actions = now === this.lastGridDownAt
      ? { throttle: [], sleep: [], wake: [], restore: [] }
      : plan({
        powerKw,
        limitKw,
        marginKw: this.marginKw,
        miners,
        slept: this.slept,
        pending: new Map([...this.pending, ...[...this.returning].map(([id, r]) => [id, { action: 'wake', kw: r.kw }])]),
        throttled: this.throttled,
        floors,
        rampKw: this._rampStepKw(),
        rampOpen: rampBlock === null,
        ecoPower: this.ecoPower
      })

    await this._apply(actions, miners, now)

    if (actions.sleep.length || actions.throttle.length) this.lastShedAt = now
    if (actions.wake.length || actions.restore.length) {
      this.lastRampAt = now
      this.steps++
    }
    const moved = Object.values(actions).some((list) => list.length)
    if (moved) {
      const parts = []
      if (actions.throttle.length) parts.push(`eco ${actions.throttle.length}`)
      if (actions.sleep.length) parts.push(`sleeping ${actions.sleep.length}`)
      if (actions.wake.length) parts.push(`waking ${actions.wake.length}`)
      if (actions.restore.length) parts.push(`back to normal ${actions.restore.length}`)
      const limit = Number.isFinite(limitKw) ? `limit ${limitKw.toFixed(0)} kW` : 'no limit'
      this.log(`Site ${powerKw.toFixed(0)} kW, ${limit}: ${parts.join(', ')}. ${this.slept.size} asleep, ${this.throttled.size} on eco.`)
    }

    this.summary = this._describe({ signals, powerKw, limitKw, miners, floors, rampBlock, actions, now })
    return { powerKw, limitKw, read: miners.length, rampBlock, ...actions }
  }

  async _apply ({ throttle, sleep, wake, restore }, miners, now) {
    const byId = new Map(miners.map((m) => [m.id, m]))
    const fullKw = (m) => this.profiles.get(m.id)?.kw ?? m.powerW / 1000
    const rank = (m) => {
      const profile = this.profiles.get(m.id)
      return profile ? wasteRank({ powerW: profile.kw * 1000, hashThs: profile.ths }) : wasteRank(m)
    }

    await Promise.all(sleep.map(async (id) => {
      const m = byId.get(id)
      if (await this._send(id, 'sleep', m.powerW / 1000, m.powerW)) {
        // The rank is how wasteful it is, so the most efficient miners wake first.
        this.slept.set(id, { kw: fullKw(m), rank: rank(m) })
      }
    }))
    await Promise.all(throttle.map(async (id) => {
      const m = byId.get(id)
      if (await this._send(id, 'throttle', (m.powerW / 1000) * (1 - this.ecoPower), m.powerW)) {
        this.throttled.set(id, { kw: fullKw(m), rank: rank(m) })
      }
    }))
    await Promise.all(wake.map(async (id) => {
      const entry = this.slept.get(id)
      if (await this._send(id, 'wake', entry.kw)) {
        this.slept.delete(id)
        this.returning.set(id, { at: now, sentAt: Date.now(), kw: entry.kw })
        // Waking with a mode change also ends eco. SealMiner's `resume` leaves it set.
        if (this.brands.get(id) !== 'sealminer') this.throttled.delete(id)
      }
    }))
    await Promise.all(restore.map(async (id) => {
      const m = byId.get(id)
      const entry = this.throttled.get(id)
      if (await this._send(id, 'restore', Math.max(0, entry.kw - m.powerW / 1000), m.powerW)) this.throttled.delete(id)
    }))
  }

  _describe ({ signals, powerKw, limitKw, miners, floors, rampBlock, actions, now }) {
    const shed = this.slept.size + this.throttled.size
    const priceShed = [...this.priceLevels.values()].filter((e) => e.level > LEVEL.NORMAL).length
    const breakevens = [...this.profiles.values()]
      .map((p) => breakevenPrice(p, signals.hashpriceUsdThDay ?? 0, this._overheadShare(), this.poolFee))
      .sort((a, b) => a - b)

    const reasons = []
    if (now === this.lastGridDownAt) reasons.push('No grid power')
    if (signals.gridAlert) reasons.push('Grid alert')
    if (priceShed) reasons.push(`Power price: ${priceShed} ${priceShed === 1 ? 'miner' : 'miners'} can't run profitably at full power`)
    const fullKw = [...this.profiles.values()].reduce((sum, p) => sum + p.kw, Math.max(0, this.overheadKw ?? 0))
    if (limitKw - this.marginKw < fullKw) reasons.push(`Power limit of ${limitKw.toFixed(0)} kW`)

    let state = 'normal'
    if (actions.sleep.length || actions.throttle.length) state = 'shedding'
    else if (this.returning.size || actions.wake.length || actions.restore.length) state = 'returning'
    else if (shed) state = rampBlock ? 'holding' : 'returning'

    return {
      state,
      reasons,
      rampBlock: shed || this.returning.size ? rampBlock : null,
      powerKw,
      limitKw: Number.isFinite(limitKw) ? limitKw : null,
      utilityLimitKw: signals.limitKw ?? null,
      capKw: this.capKw ?? null,
      priceUsdKwh: signals.priceUsdKwh ?? null,
      breakevenUsdKwh: breakevens.length ? breakevens[breakevens.length >> 1] : null,
      gridAlert: Boolean(signals.gridAlert),
      signalsLost: this.signalsLost,
      miners: this.miners.length,
      seen: miners.length,
      asleep: this.slept.size,
      eco: this.throttled.size,
      returning: this.returning.size,
      notBack: [...this.notBack],
      failedCommands: this.rejected,
      steps: this.steps,
      recent: this.recent
    }
  }

  // What the panel shows.
  status () {
    return this.summary ?? { state: 'starting', reasons: [], recent: this.recent, capKw: this.capKw ?? null }
  }

  start () {
    let running = false
    const run = async () => {
      // A slow read must not overlap the next tick.
      if (running) return
      running = true
      try {
        await this.tick()
      } catch (err) {
        this.log(`Tick failed: ${err.message}`)
      } finally {
        running = false
      }
    }
    run()
    this.timer = setInterval(run, this.tickMs)
  }

  stop () {
    clearInterval(this.timer)
  }
}

module.exports = { CurtailmentResponder, plan, wakeCommand, wasteRank, breakevenPrice, priceLevelFor, nextPriceLevel, LEVEL, DEFAULTS }
