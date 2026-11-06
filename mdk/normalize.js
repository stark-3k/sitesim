'use strict'

// Turns what MDK's Workers report into one miner format, whichever brand it came
// from. Every Worker differs: status words, fan units, and how errors look. Written
// from real Worker output, saved in test/fixtures/mdk-telemetry.json.

// Telemetry fields that fail come back as { error }, rather than a value.
const value = (field) => (field !== null && typeof field === 'object' && 'error' in field ? undefined : field)
const number = (field) => {
  const v = value(field)
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// A typical full fan speed, used only where a Worker reports RPM and no percentage.
const FULL_FAN_RPM = 6200
const HOT_C = 92

const STATUS = {
  mining: 'mining',
  running: 'mining',
  sleeping: 'sleeping',
  suspended: 'sleeping',
  not_mining: 'booting',
  initializing: 'booting',
  error: 'error'
}

function fanPercent (m) {
  const fans = value(m.fans)
  if (Array.isArray(fans) && fans.length) {
    const first = fans[0]
    const pct = first.speed_pct ?? first.percentage
    // A stalled fan can report a high duty with no speed, so RPM wins when it's low.
    const rpm = first.rpm ?? first.speed
    if (typeof rpm === 'number') {
      const fromRpm = (rpm / FULL_FAN_RPM) * 100
      return typeof pct === 'number' ? Math.min(pct, fromRpm) : fromRpm
    }
    if (typeof pct === 'number') return pct
  }
  const rpm = number(m.fan_speed) ?? number(m.fan_speed_in)
  return rpm === null ? null : (rpm / FULL_FAN_RPM) * 100
}

// Informational entries are states, not faults: SealMiner lists "tuning" and
// "suspended" among its errors, and LuxOS can list a "tuned" event.
function activeErrors (m) {
  const errors = value(m.errors)
  if (!Array.isArray(errors)) return []
  return errors.filter((e) => !/^info$/i.test(e?.severity ?? ''))
}

// A word for each fault, drawn from what the Worker said, which is all MDK knows.
function faultNames (errors) {
  const names = new Set()
  for (const e of errors) {
    const text = `${e.code ?? ''} ${e.name ?? ''} ${e.description ?? ''} ${e.message ?? ''} ${e.detail ?? ''}`.toLowerCase()
    // Temperature first, since "hashboard_temp_overheating" also mentions a board,
    // and the control board first among boards.
    if (/fan/.test(text)) names.add('fan')
    else if (/temp|overheat/.test(text)) names.add('temp')
    else if (/control/.test(text)) names.add('ctrl')
    else if (/board/.test(text)) names.add('board')
    else if (/psu|power/.test(text)) names.add('psu')
    else if (/pool/.test(text)) names.add('pool')
    else names.add('error')
  }
  return [...names]
}

function poolIndex (pools) {
  if (!Array.isArray(pools)) return -1
  return pools.findIndex((p) => p?.stratum_active === true || p?.stratum?.active === true || p?.status === 'Active')
}

/**
 * @param {object} metrics what the Kernel returned for this miner
 * @param {object} entry its place in the site map: { id, c, model, nth, nw }
 * @returns the miner in the same shape the panel uses
 */
function normalizeMiner (metrics, entry) {
  const statusWord = value(metrics.status)
  // Every field failing means the device didn't answer at all.
  const reachable = typeof statusWord === 'string'
  const status = reachable ? (STATUS[statusWord] ?? 'unknown') : 'unknown'
  const ths = number(metrics.hashrate_rt) ?? number(metrics.hashrate_avg) ?? 0
  const temp = number(metrics.temperature)
  const errors = activeErrors(metrics)

  // "Error" says nothing about whether it's hashing. A faulted miner still earning
  // is shown as mining with a fault mark, and only a stopped one as failed.
  let s = status
  if (status === 'error') s = ths > 0 ? 'mining' : 'failed'

  const flt = faultNames(errors)
  if (status === 'error' && !flt.length) flt.push('error')

  return {
    id: entry.id,
    c: entry.c,
    model: entry.model,
    nth: entry.nth,
    nw: entry.nw,
    s,
    ths: reachable ? ths : 0,
    w: reachable ? Math.round(number(metrics.power) ?? 0) : 0,
    temp: temp ?? 0,
    fan: Math.round(fanPercent(metrics) ?? 0),
    mode: value(metrics.power_mode) ?? 'unknown',
    net: reachable,
    flt,
    hot: temp !== null && temp >= HOT_C,
    pool: poolIndex(value(metrics.pools)),
    led: false,
    reported: statusWord ?? null
  }
}

function normalizeMeter (metrics) {
  const watts = number(metrics.active_power)
  const volts = number(metrics.voltage)
  return {
    powerKw: watts === null ? null : watts / 1000,
    voltageV: volts,
    // Zero volts at the meter is how MDK can tell the supply has gone.
    dead: volts === 0
  }
}

// 850.0 is the Seneca driver's error reading.
function normalizeSensor (metrics) {
  const temp = number(metrics.temperature)
  if (temp === null || temp >= 850) return { temp: null, fault: temp !== null }
  return { temp, fault: false }
}

// How each brand expresses the same request. Returns [command, params], or null
// when the Worker has no such command, so the panel can say so plainly.
function commandFor (brand, action, value) {
  const modes = {
    antminer: { normal: 'normal', high: 'high', eco: 'low' },
    whatsminer: { normal: 'normal', high: 'high', eco: 'low' },
    sealminer: { normal: 'normal', high: 'high_performance', eco: 'low_power' },
    avalon: { normal: 'normal', high: 'high' }
  }
  switch (action) {
    case 'sleep':
      return ['setPowerMode', { mode: 'sleep' }]
    case 'wake':
      return brand === 'sealminer' ? ['resume', {}] : ['setPowerMode', { mode: 'normal' }]
    case 'reboot':
      return ['reboot', {}]
    case 'led':
      return brand === 'sealminer' ? null : ['setLED', { enabled: Boolean(value) }]
    case 'mode': {
      if (brand === 'luxos') {
        const profile = { normal: 'default', high: '750MHz', eco: '450MHz' }[value]
        return profile ? ['setProfile', { profile }] : null
      }
      if (brand === 'proto') {
        const mode = { normal: 'MaximumHashrate', eco: 'Efficiency' }[value]
        return mode ? ['setPerformanceMode', { mode }] : null
      }
      const mode = modes[brand]?.[value]
      return mode ? ['setPowerMode', { mode }] : null
    }
    case 'powerPct': {
      const pct = Number(value)
      if (!Number.isFinite(pct)) return null
      if (brand === 'antminer') return ['setHashratePercent', { pct }]
      if (brand === 'whatsminer') return ['setPowerPct', { pct }]
      return null
    }
    case 'powerW': {
      const watts = Number(value)
      if (!Number.isFinite(watts)) return null
      if (brand === 'sealminer') return ['setPowerLimit', { watts }]
      if (brand === 'proto') return ['setPowerTarget', { watts }]
      return null
    }
    default:
      return null
  }
}

module.exports = { normalizeMiner, normalizeMeter, normalizeSensor, commandFor }
