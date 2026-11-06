'use strict'

// SealMiner bdminer API on port 4028, as MDK's SealMiner Worker uses it: one
// JSON request per connection, ended by a half-close, then one JSON reply.
// Field names follow the vendor's real-hardware captures.

const DESCRIPTION = 'bdminer 4.11.1'
const FIRMWARE = '2026060901'
const FAN_COUNT = 4
const TEMP_SENSORS = 4

const MODE_LABEL = { normal: 'Normal', high: 'High Performance', eco: 'Low Power' }
const WORKMODE_TO_MODE = { normal: 'normal', high_performance: 'high', low_power: 'eco' }
const ACCEPTED_SETTINGS = new Set(['timezone', 'preheat', 'fast-raise-freq', 'hostname', 'network', 'webpasswd', 'idle-fan-timer', 'stratum-disconnect-timeout'])
const SUBCOMMANDS = ['suspend', 'resume', 'powerlimit', 'workmode', ...ACCEPTED_SETTINGS, 'miner-status']

const CODES = {
  version: [22, 'BDMiner versions'],
  summary: [11, 'Summary'],
  config: [33, 'Bdminer config'],
  devs: [9, '1 ASC(s)'],
  pools: [7, 'Pool(s)'],
  devdetails: [69, 'Device Details'],
  stats: [70, 'BDMiner stats'],
  coin: [78, 'Bdminer coin'],
  updatepools: [200, 'Update pools success'],
  ascset: [119, 'ASC 0 set OK']
}

const now = () => Math.floor(Date.now() / 1000)
const round = (value) => Math.round(value * 100) / 100

function envelope (command, section, payload, over = {}) {
  const [code, msg] = CODES[command] || [0, command]
  const body = {
    STATUS: [{ STATUS: over.letter || 'S', When: now(), Code: over.code ?? code, Msg: over.msg || msg, Description: DESCRIPTION }],
    id: 1
  }
  if (section) body[section] = Array.isArray(payload) ? payload : [payload]
  return body
}

const errorReply = (code, msg) => ({
  STATUS: [{ STATUS: 'E', When: now(), Code: code, Msg: msg, Description: DESCRIPTION }],
  id: 1
})

function elapsed (miner, sim) {
  return Math.max(0, Math.floor(sim.t - miner.bootedAt))
}

function pmState (miner) {
  if (miner.suspended || miner.state === 'sleeping') return 'Suspended'
  if (miner.state === 'mining') return 'Running'
  if (miner.state === 'failed' || miner.state === 'tripped') return 'Suspend Failed'
  return 'Initializing'
}

function hashWindows (out, prefix, ema, ths) {
  const mhs = (value) => round(value * 1e6)
  const windows = { Sample: ths, '30s': ema.s30, '1m': ema.m1, '2m': ema.m1, '5m': ema.m5, '15m': ema.m15, '30m': ema.m15, '1h': ema.m15, '2h': ema.m15, Avg: ema.m5, Avg2: ema.m5 }
  for (const [label, value] of Object.entries(windows)) out[`${prefix}(${label})`] = mhs(value)
}

function stats (miner, sim) {
  const { spec, fx, ema } = miner
  const ideal = spec.nominalThs * miner.mode.hash * miner.powerScale ** 0.85
  const alive = Math.max(0, spec.boards - fx.boardsDown)
  const suspended = pmState(miner) === 'Suspended'
  const chipCount = 459
  const perBoard = Math.floor(chipCount / spec.boards)
  let errorCode = ''
  if (fx.controlBoard) errorCode = '0x00000101'
  else if (miner.overheating) errorCode = '0x00000201'
  else if (fx.boardsDown > 0) errorCode = '0x00000301'

  const out = {
    STATS: 0,
    ID: `${spec.name}0`,
    Elapsed: elapsed(miner, sim),
    Calls: 0,
    Wait: 0,
    Max: 0,
    Min: 99999999,
    Model: spec.name,
    ASIC: 'Seal02-V1',
    Firmware: FIRMWARE,
    'Software Version': '4.11.1-08730-sim',
    IP: sim.cfg.host,
    MAC: `00:00:5e:00:${(miner.index >> 8).toString(16).padStart(2, '0')}:${(miner.index & 255).toString(16).padStart(2, '0')}`,
    'Ctrl Board': 'taurus_air_v1.1',
    'Ctrl Board SN': miner.serial,
    'Public Key': 'publ_key_user1.key',
    Debug: true,
    'PM State': pmState(miner),
    'BIN Version': 1,
    'BIN Number': 33,
    'Chip Count': perBoard * spec.boards,
    'Bad Chip Count': Math.round(perBoard * spec.boards * fx.chipLoss),
    'Mining Mode': MODE_LABEL[miner.mode.name] || 'Normal',
    Temp: Math.round(miner.chipC),
    'Error Chip': '',
    'Stratum Disconnect': miner.activePool < 0 && miner.state === 'mining',
    'Error Code': errorCode,
    'Boot Time': 216.5,
    'Boot Temp': 32,
    'Coarse Tune Time': 606.8,
    'Fine Tune Time': 457.2,
    'Tune Status': 'Fine Tuning Done',
    'Tune Time': 1069.2,
    'Raise Freq Done': true,
    'Raise Freq Done Reason': 'Power Efficiency Limit',
    'Raise Freq Time': 538.7,
    'Fast Raise Freq': false,
    'Custom Power Ratio': 27,
    'Liquid Cooling': false,
    'Boot Count': 1,
    'System Uptime': Math.floor(sim.t),
    'Target Ctrl Temp': spec.throttleC,
    'MHS(Rated)': round(spec.nominalThs * 1e6),
    'Hashrate Boost Ratio': 0,
    'Profit Boost Ratio': 0,
    'Power Limit': Math.round(spec.nominalW * miner.powerScale),
    'Total Energy Consumption': 0,
    'Pools Locked': false,
    'MHS(Ideal)': round(ideal * 1e6),
    Freq: miner.state === 'mining' ? 381 : 0
  }

  hashWindows(out, 'MHS', ema, miner.ths)
  const pr = ideal > 0 ? (miner.ths / ideal) * 100 : 0
  for (const label of ['30s', '1m', '2m', '5m', '15m', '30m', '1h', '2h', 'Avg']) out[`PR(${label})`] = round(pr)

  const power = Math.round(miner.powerW)
  Object.assign(out, {
    'PSU Model': 'BTPSU04KSA-03.00',
    'PSU Firmware': '222121',
    'PSU SN': `3C${String(miner.index).padStart(9, '0')}`,
    'PSU Input Voltage': 233.35,
    'PSU Output Voltage': 13.665,
    'PSU Output Current': round(power * 0.936 / 13.665),
    'PSU Input Power': power,
    'PSU Output Power': Math.round(power * 0.936),
    'PSU Fan Speed': suspended ? 0 : 7500,
    'PSU Temp AMB': Math.round(miner.inletC),
    'PSU Efficiency': 0.913741,
    'PSU Error': fx.psuFailed ? '0x00000080' : suspended ? '0x00000040' : '0x00000000',
    'Chip Voltage': 308
  })

  const wt = miner.ths > 0 ? power / miner.ths : 0
  for (const label of ['30s', '1m', '2m', '5m', '15m', '30m', '1h', '2h', 'Avg']) out[`W/T(${label})`] = round(wt)

  out['Fan Count'] = FAN_COUNT
  for (let i = 0; i < FAN_COUNT; i++) {
    out[`${i} PWM`] = suspended ? 0 : Math.round(miner.fanPct * 2.55)
    out[`${i} Speed`] = suspended ? 0 : Math.round(miner.fanPct * (1 - fx.fanLoss) * 62)
  }

  out['Board Count'] = spec.boards
  for (let b = 0; b < spec.boards; b++) {
    const online = b < alive
    const share = online && alive ? 1 / alive : 0
    const scaled = { s30: ema.s30 * share, m1: ema.m1 * share, m5: ema.m5 * share, m15: ema.m15 * share }
    out[`${b} SN`] = `${miner.serial}B${b}`
    out[`${b} Marking`] = 'A040CFBK04000'
    out[`${b} Online`] = online
    out[`${b} Chip Count`] = perBoard
    out[`${b} Bad Chip Count`] = Math.round(perBoard * fx.chipLoss)
    out[`${b} Bad Chip Ratio`] = round(fx.chipLoss)
    out[`${b} Tune Status`] = 'Fine Tuning Done'
    out[`${b} Total MH`] = 0
    out[`${b} MHS(Ideal)`] = round(ideal * 1e6 / spec.boards)
    out[`${b} Freq`] = miner.state === 'mining' ? 380 : 0
    hashWindows(out, `${b} MHS`, scaled, miner.ths * share)
    const boardPr = ideal > 0 ? (miner.ths * share) / (ideal / spec.boards) * 100 : 0
    for (const label of ['30s', '1m', '2m', '5m', '15m', '30m', '1h', '2h', 'Avg']) out[`${b} PR(${label})`] = round(boardPr)
    out[`${b} Low Hash`] = !online
    for (let sensor = 0; sensor < TEMP_SENSORS; sensor++) {
      out[`${b} Temp ${sensor}`] = Math.round(miner.chipC - (TEMP_SENSORS - 1 - sensor) * 3)
    }
    out[`${b} MW`] = 5999
    out[`${b} HW`] = Math.floor(miner.hwErrors / spec.boards)
    out[`${b} ULVT PMOS(Avg)`] = 18025
    out[`${b} ULVT NMOS(Avg)`] = 20218
    out[`${b} ELVT PMOS(Avg)`] = 6998
    out[`${b} ELVT NMOS(Avg)`] = 7181
    out[`${b} ULVTLL PMOS(Avg)`] = 39870
    out[`${b} ULVTLL NMOS(Avg)`] = 45824
  }
  return out
}

function counters (miner) {
  return miner.pools.reduce((sum, pool) => ({
    accepted: sum.accepted + pool.accepted,
    rejected: sum.rejected + pool.rejected,
    stale: sum.stale + pool.stale
  }), { accepted: 0, rejected: 0, stale: 0 })
}

function summary (miner, sim) {
  const { ema } = miner
  const { accepted, rejected, stale } = counters(miner)
  const total = accepted + rejected
  const rate = total ? round(rejected / total * 100) : 0
  return {
    Elapsed: elapsed(miner, sim),
    'MHS av': round(ema.m5 * 1e6),
    'MHS 5s': round(miner.ths * 1e6),
    'MHS 1m': round(ema.m1 * 1e6),
    'MHS 5m': round(ema.m5 * 1e6),
    'MHS 15m': round(ema.m15 * 1e6),
    'Found Blocks': 0,
    Getworks: 0,
    Accepted: accepted,
    Rejected: rejected,
    'Hardware Errors': Math.floor(miner.hwErrors),
    Utility: 0,
    Discarded: 0,
    Stale: stale,
    'Get Failures': 0,
    'Local Work': 0,
    'Remote Failures': 0,
    'Network Blocks': 0,
    'Total MH': 0,
    'Work Utility': 0,
    'Difficulty Accepted': accepted,
    'Difficulty Rejected': rejected,
    'Difficulty Stale': stale,
    'Best Share': 0,
    'Device Hardware%': 0,
    'Device Rejected%': rate,
    'Pool Rejected%': rate,
    'Pool Stale%': 0,
    'Last getwork': now()
  }
}

function pools (miner, sim) {
  return miner.pools.map((entry, index) => {
    const pool = sim.poolForUrl(entry.url)
    const active = index === miner.activePool
    return {
      POOL: index,
      URL: entry.url,
      Status: pool && !pool.fx.down && !miner.fx.netDown ? 'Alive' : 'Dead',
      Priority: index,
      Quota: 1,
      'Long Poll': 'N',
      Getworks: 0,
      Accepted: entry.accepted,
      Rejected: entry.rejected,
      Works: 0,
      Discarded: 0,
      Stale: entry.stale,
      'Get Failures': 0,
      'Remote Failures': 0,
      User: entry.user,
      'Last Share Time': now(),
      'Diff1 Shares': 0,
      'Proxy Type': '',
      Proxy: '',
      'Difficulty Accepted': entry.accepted,
      'Difficulty Rejected': entry.rejected,
      'Difficulty Stale': entry.stale,
      'Last Share Difficulty': 0,
      'Work Difficulty': 0,
      'Has Stratum': true,
      'Stratum Active': active,
      'Stratum URL': active ? entry.url.replace(/^stratum\+tcp:\/\//, '').split(':')[0] : '',
      'Stratum Difficulty': sim.cfg.pools.shareDifficulty,
      'Has Vmask': true,
      'Has GBT': false,
      'Best Share': 0,
      'Pool Rejected%': 0,
      'Pool Stale%': 0,
      'Bad Work': 0,
      'Current Block Height': 0,
      'Current Block Version': 0
    }
  })
}

function devs (miner, sim) {
  const { ema } = miner
  const { accepted, rejected } = counters(miner)
  return [{
    ASC: 0,
    Name: miner.spec.name,
    ID: 0,
    Enabled: 'Y',
    Status: miner.state === 'mining' ? 'Alive' : 'Sick',
    Temperature: Math.round(miner.chipC),
    'MHS av': round(ema.m5 * 1e6),
    'MHS 5s': round(miner.ths * 1e6),
    'MHS 1m': round(ema.m1 * 1e6),
    'MHS 5m': round(ema.m5 * 1e6),
    'MHS 15m': round(ema.m15 * 1e6),
    Accepted: accepted,
    Rejected: rejected,
    'Hardware Errors': Math.floor(miner.hwErrors),
    Utility: 0,
    'Device Elapsed': elapsed(miner, sim)
  }]
}

// "0,workmode,{"mode":"normal"}": the JSON can contain commas, so only the first
// two separators are structural.
function splitAscset (parameter) {
  const text = String(parameter || '')
  const first = text.indexOf(',')
  if (first === -1) return { sub: '', json: null }
  const second = text.indexOf(',', first + 1)
  if (second === -1) return { sub: text.slice(first + 1).trim(), json: null }
  return { sub: text.slice(first + 1, second).trim(), json: text.slice(second + 1).trim() }
}

function ascset (miner, sim, parameter) {
  const { sub, json } = splitAscset(parameter)
  if (sub === 'help') {
    return envelope('ascset', null, null, { letter: 'I', code: 118, msg: `ASC 0 set help: ${SUBCOMMANDS.join(' & ')}` })
  }
  if (!SUBCOMMANDS.includes(sub)) return errorReply(14, `ASC 0 set failed: unknown ${sub}`)

  let args = {}
  if (json) {
    try {
      args = JSON.parse(json)
    } catch {
      return errorReply(23, 'Invalid JSON format')
    }
  }

  switch (sub) {
    case 'suspend':
      sim.minerCommand(miner.id, 'sleep', undefined, 'sealminer')
      break
    case 'resume':
      sim.minerCommand(miner.id, 'wake', undefined, 'sealminer')
      break
    case 'powerlimit': {
      // Real firmware refuses non-string values with this message.
      if (typeof args.value !== 'string') return errorReply(120, 'ASC 0 set failed: Missing "value"')
      const watts = Number(args.value)
      if (!Number.isFinite(watts) || watts <= 0) return errorReply(120, 'ASC 0 set failed: bad powerlimit')
      const pct = Math.min(120, Math.max(10, watts / miner.spec.nominalW * 100))
      sim.minerCommand(miner.id, 'powerPct', pct, 'sealminer')
      break
    }
    case 'workmode': {
      if (typeof args.mode !== 'string') return errorReply(120, 'ASC 0 set failed: Missing "mode"')
      if (args.mode === 'sleep') {
        sim.minerCommand(miner.id, 'sleep', undefined, 'sealminer')
      } else if (WORKMODE_TO_MODE[args.mode]) {
        sim.minerCommand(miner.id, 'mode', WORKMODE_TO_MODE[args.mode], 'sealminer')
      } else {
        return errorReply(120, `ASC 0 set failed: bad workmode ${args.mode}`)
      }
      break
    }
    default:
      // Accepted and ignored: these settings have no effect on the physics.
      break
  }
  return envelope('ascset', null, null, {})
}

function updatepools (miner, sim, parameter) {
  let parsed
  try {
    parsed = JSON.parse(String(parameter || ''))
  } catch {
    return errorReply(23, 'Invalid JSON format')
  }
  const list = parsed?.pools
  if (!Array.isArray(list) || list.length === 0) return errorReply(8, 'No available pool')
  if (list.some((p) => !p || typeof p.url !== 'string' || p.url === '')) return errorReply(201, 'Update fail')
  sim.setMinerPools(miner.id, list.map((p) => ({ url: p.url, user: p.user || '', password: p.pass || '' })), 'sealminer')
  return envelope('updatepools', null, null, {})
}

function respond (miner, sim, request) {
  const command = String(request?.command || '')
  switch (command) {
    case 'version': return envelope(command, 'VERSION', { BDMiner: '4.11.1', API: '3.7' })
    case 'summary': return envelope(command, 'SUMMARY', summary(miner, sim))
    case 'config':
      return envelope(command, 'CONFIG', { 'ASC Count': 1, 'PGA Count': 0, 'Pool Count': miner.pools.length, Strategy: 'Failover', 'Log Interval': 5, 'Device Code': '', OS: 'Linux', Hotplug: 'None' })
    case 'devs': return envelope(command, 'DEVS', devs(miner, sim))
    case 'pools': return envelope(command, 'POOLS', pools(miner, sim))
    case 'devdetails':
      return envelope(command, 'DEVDETAILS', { DEVDETAILS: 0, Name: miner.spec.name, ID: 0, Driver: 'Sealminer', Kernel: '', Model: miner.spec.name, 'Device Path': '' })
    case 'stats': return envelope(command, 'STATS', stats(miner, sim))
    case 'coin':
      return envelope(command, 'COIN', { 'Hash Method': 'sha256', 'Current Block Time': now(), CurrentBlockHash: '0'.repeat(64), LP: true, 'Network Difficulty': 0 })
    case 'restart':
    case 'reboot':
      sim.minerCommand(miner.id, 'reboot', undefined, 'sealminer')
      return { STATUS: command.toUpperCase(), id: 1 }
    case 'updatepools': return updatepools(miner, sim, request.parameter)
    case 'ascset': return ascset(miner, sim, request.parameter)
    default: return errorReply(14, 'Invalid command')
  }
}

module.exports = { respond }
