'use strict'

const STATE = Object.freeze({
  OFF: 'off',
  BOOTING: 'booting',
  MINING: 'mining',
  SLEEPING: 'sleeping',
  TRIPPED: 'tripped',
  FAILED: 'failed'
})

const STOP_TAU_SEC = 5

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const emaStep = (dt, tau) => 1 - Math.exp(-dt / tau)

function emptyFx () {
  return {
    fanLoss: 0,
    boardsDown: 0,
    psuFailed: false,
    netDown: false,
    netDelayMs: 0,
    chipLoss: 0,
    hang: false,
    controlBoard: false
  }
}

class Miner {
  constructor ({ id, index, containerId, port, serial, spec, rng, pools }) {
    this.model = spec.id
    this.id = id
    this.index = index
    this.containerId = containerId
    this.port = port
    this.serial = serial
    this.spec = spec
    this.rng = rng

    // Per-unit variation, so no two machines read exactly the same.
    this.hashFactor = rng.range(0.97, 1.03)
    this.powerFactor = rng.range(0.98, 1.02)
    this.thermalFactor = rng.range(0.96, 1.05)

    this.state = STATE.OFF
    this.suspended = false
    this.workMode = 0
    this.led = false
    this.manualFanPct = null
    this.powerScale = 1
    this.username = 'root'
    this.password = 'root'
    this.bootBy = '0x05.00000000'
    this.bootLeft = 0
    this.bootedAt = 0
    this.fx = emptyFx()

    this.chipC = 30
    this.tMaxC = 30
    this.inletC = 25
    this.fanPct = 30
    this.ths = 0
    this.powerW = 0
    this.chipW = 0
    this.hwErrors = 0
    this.ema = { s30: 0, m1: 0, m5: 0, m15: 0 }
    this.history = { t: [], temp: [], ths: [], power: [] }

    this.setPools(pools)
    this.activePool = -1
    this.creditedThs = 0
    this.lastBootReason = 'power-on'
  }

  setPools (pools) {
    this.pools = pools.map((pool) => ({
      url: pool.url,
      user: pool.user,
      password: pool.password || 'x',
      accepted: 0,
      rejected: 0,
      stale: 0,
      shareFraction: 0,
      rejectFraction: 0,
      staleFraction: 0
    }))
  }

  get reachable () {
    const unpowered = this.state === STATE.OFF || this.state === STATE.BOOTING
    return !unpowered && !this.fx.netDown
  }

  // True once the thermal cut-out has opened, and while running hot enough to
  // report the error code the Avalon driver maps to hashboard_temp_overheating.
  get overheating () {
    return this.state === STATE.TRIPPED || this.chipC >= this.spec.errorC
  }

  get mode () {
    return this.spec.modes[this.workMode] || this.spec.modes[0]
  }

  boot (t, reason) {
    this.state = STATE.BOOTING
    this.bootLeft = this.rng.range(this.spec.bootSec[0], this.spec.bootSec[1])
    this.bootedAt = t
    this.lastBootReason = reason
    this.ema = { s30: 0, m1: 0, m5: 0, m15: 0 }
    this.suspended = false
  }

  powerLoss () {
    this.state = STATE.OFF
    this.bootLeft = 0
    this.ths = 0
    this.creditedThs = 0
  }

  // Advances the state machine. Returns an event for the log, or null.
  transition (t, dt, powered) {
    const { spec, fx } = this
    if (!powered) {
      if (this.state !== STATE.OFF) this.powerLoss()
      return null
    }

    switch (this.state) {
      case STATE.OFF:
        this.boot(t, 'power-restored')
        return null
      case STATE.BOOTING:
        this.bootLeft -= dt
        if (this.bootLeft <= 0) this.state = fx.psuFailed ? STATE.FAILED : STATE.MINING
        return null
      case STATE.MINING:
        if (fx.psuFailed) {
          this.state = STATE.FAILED
          return null
        }
        if (this.suspended) {
          this.state = STATE.SLEEPING
          return null
        }
        if (this.chipC >= spec.tripC) {
          this.state = STATE.TRIPPED
          return { level: 'error', message: `${this.id} tripped its thermal cut-out at ${this.chipC.toFixed(0)}°C` }
        }
        return null
      case STATE.SLEEPING:
        if (!this.suspended) this.state = STATE.MINING
        return null
      case STATE.TRIPPED:
        if (this.chipC <= spec.recoverC) {
          this.boot(t, 'thermal-recovery')
          return { level: 'info', message: `${this.id} cooled down and is restarting` }
        }
        return null
      case STATE.FAILED:
        if (!fx.psuFailed) this.boot(t, 'repaired')
        return null
    }
    return null
  }

  step (t, dt, inletC, powered) {
    const { spec, fx } = this
    const event = this.transition(t, dt, powered)
    this.inletC = inletC

    let targetThs = 0
    let targetW = 0
    if (this.state === STATE.MINING) {
      const boards = Math.max(0, spec.boards - fx.boardsDown) / spec.boards
      const over = this.chipC - spec.throttleC
      const throttle = over > 0 ? clamp(1 - over * 0.06, 0.4, 1) : 1
      const { hash, power } = this.mode
      targetW = spec.nominalW * this.powerFactor * power * boards * this.powerScale * (0.5 + 0.5 * throttle)
      // Less power means less voltage too, so hashrate falls more slowly than power.
      const limit = this.powerScale ** 0.85
      // A hung firmware keeps the chips powered but produces no valid work.
      targetThs = fx.hang ? 0 : spec.nominalThs * this.hashFactor * hash * boards * throttle * limit * (1 - fx.chipLoss)
    } else if (this.state === STATE.SLEEPING || this.state === STATE.TRIPPED || this.state === STATE.FAILED) {
      targetW = spec.sleepW
    } else if (this.state === STATE.BOOTING) {
      targetW = spec.bootW
    }

    // A stopped miner stops hashing within seconds. Hung firmware stays in the
    // mining state, so its hashrate fades at the normal rate.
    const stopped = this.state !== STATE.MINING
    this.ths += (targetThs - this.ths) * emaStep(dt, stopped ? STOP_TAU_SEC : spec.hashTauSec)
    if (targetThs === 0 && this.ths < 0.01) this.ths = 0
    // Losing the feed drops the load at once; everything else ramps.
    const chipW = this.state === STATE.OFF ? 0 : this.chipW + (targetW - this.chipW) * emaStep(dt, 10)
    this.chipW = chipW

    if (this.state === STATE.OFF) {
      this.fanPct = 0
    } else if (this.manualFanPct !== null && this.state !== STATE.TRIPPED) {
      this.fanPct = this.manualFanPct
    } else if (this.state === STATE.TRIPPED) {
      this.fanPct = 100
    } else {
      this.fanPct = clamp(30 + (this.chipC - 55) * 3.5, 25, 100)
    }

    const fanFraction = this.fanPct / 100
    const airflow = fanFraction * (1 - fx.fanLoss)
    const fanW = this.state === STATE.OFF ? 0 : spec.fanMaxW * fanFraction ** 3 * (1 - fx.fanLoss)
    this.powerW = chipW + fanW

    const resistance = (spec.rBase + spec.rAirflowPenalty * (1 - airflow) ** 1.5) * this.thermalFactor
    const targetC = inletC + chipW * resistance
    this.chipC += (targetC - this.chipC) * emaStep(dt, spec.thermalTauSec)
    this.tMaxC = this.chipC + 2.5

    this.ema.s30 += (this.ths - this.ema.s30) * emaStep(dt, 30)
    this.ema.m1 += (this.ths - this.ema.m1) * emaStep(dt, 60)
    this.ema.m5 += (this.ths - this.ema.m5) * emaStep(dt, 300)
    this.ema.m15 += (this.ths - this.ema.m15) * emaStep(dt, 900)
    // Firmware reports zero once mining stops. Averages left to fade would stay
    // above zero for an hour, and drivers read any non-zero average as mining.
    if (stopped && this.ths === 0) this.ema = { s30: 0, m1: 0, m5: 0, m15: 0 }
    if (fx.chipLoss > 0) this.hwErrors += this.ths * fx.chipLoss * dt * 0.02
    return event
  }

  // Share counters follow from the hashrate, the pool's difficulty and its rates.
  creditShares (dt, difficulty, staleRate, rejectRate) {
    const entry = this.pools[this.activePool]
    if (!entry) return
    const perSec = (this.ths * 1e12) / (difficulty * 2 ** 32)
    const shares = perSec * dt
    entry.shareFraction += shares * (1 - staleRate - rejectRate)
    entry.rejectFraction += shares * rejectRate
    entry.staleFraction += shares * staleRate
    const whole = (key, counter) => {
      const count = Math.floor(entry[key])
      entry[counter] += count
      entry[key] -= count
    }
    whole('shareFraction', 'accepted')
    whole('rejectFraction', 'rejected')
    whole('staleFraction', 'stale')
  }

  sample (t) {
    const { history } = this
    history.t.push(t)
    history.temp.push(+this.chipC.toFixed(1))
    history.ths.push(+this.ths.toFixed(1))
    history.power.push(Math.round(this.powerW))
    if (history.t.length > 240) {
      history.t.shift()
      history.temp.shift()
      history.ths.shift()
      history.power.shift()
    }
  }

  view () {
    return {
      id: this.id,
      c: this.containerId,
      model: this.model,
      nth: this.spec.nominalThs,
      nw: this.spec.nominalW,
      s: this.state,
      ths: +this.ths.toFixed(1),
      w: Math.round(this.powerW),
      temp: +this.chipC.toFixed(1),
      fan: Math.round(this.fanPct),
      mode: this.mode.name,
      net: !this.fx.netDown,
      flt: this.faultNames,
      hot: this.overheating,
      pool: this.activePool,
      led: this.led
    }
  }

  get faultNames () {
    const { fx } = this
    const names = []
    if (fx.fanLoss > 0) names.push('fan')
    if (fx.boardsDown > 0) names.push('board')
    if (fx.psuFailed) names.push('psu')
    if (fx.netDown) names.push('net')
    if (fx.netDelayMs > 0) names.push('latency')
    if (fx.chipLoss > 0) names.push('chips')
    if (fx.hang) names.push('hang')
    if (fx.controlBoard) names.push('ctrl')
    return names
  }
}

module.exports = { Miner, STATE, emptyFx }
