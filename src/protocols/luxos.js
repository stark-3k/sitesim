'use strict'

// LuxOS TCP API on port 4028, as MDK's LuxOS Worker uses it: one JSON request
// per connection, a NUL-terminated JSON reply, then the miner closes.

const SESSION_COMMANDS = new Set(['rebootdevice', 'ledset', 'curtail', 'profileset', 'logoff'])
const SESSION_TIMEOUT_MS = 5 * 60 * 1000
const FAN_COUNT = 4

// Tuning profiles stand in for the engine's work modes.
const PROFILES = { default: 'normal', '750MHz': 'high', '450MHz': 'eco' }

const status = (code, msg, ok = true) => ({
  STATUS: [{ Code: code, Description: 'LUXminer sim', Msg: msg, STATUS: ok ? 'S' : 'E', When: Math.floor(Date.now() / 1000) }],
  id: 1
})

const fail = (msg) => status(14, msg, false)
const round = (value, digits = 2) => Number(value.toFixed(digits))

function elapsed (miner, sim) {
  return Math.max(0, Math.floor(sim.t - miner.bootedAt))
}

function profileName (miner) {
  return Object.entries(PROFILES).find(([, mode]) => mode === miner.mode.name)?.[0] || 'default'
}

function activeSession (miner) {
  const session = miner.luxSession
  if (!session) return ''
  if (Date.now() - session.at > SESSION_TIMEOUT_MS) {
    miner.luxSession = null
    return ''
  }
  return session.id
}

function poolCounters (miner) {
  return miner.pools.reduce((sum, pool) => ({
    accepted: sum.accepted + pool.accepted,
    rejected: sum.rejected + pool.rejected,
    stale: sum.stale + pool.stale
  }), { accepted: 0, rejected: 0, stale: 0 })
}

function boardRows (miner) {
  const { spec, fx } = miner
  const alive = Math.max(0, spec.boards - fx.boardsDown)
  return Array.from({ length: spec.boards }, (_, id) => {
    const up = id < alive
    const share = up && alive ? 1 / alive : 0
    return {
      ASC: id,
      ID: id,
      Connector: `J${id + 6}`,
      Enabled: 'Y',
      Status: up ? 'Alive' : 'Dead',
      Profile: profileName(miner),
      SerialNumber: `${miner.serial}B${id}`,
      'MHS 5s': round(miner.ths * 1e6 * share),
      'MHS av': round(miner.ema.m5 * 1e6 * share),
      'Nominal MHS': round(spec.nominalThs * 1e6 / spec.boards),
      Temperature: round(miner.chipC, 1),
      'Hardware Errors': Math.floor(miner.hwErrors),
      IsRamping: miner.state === 'booting',
      IsUserShutdown: miner.suspended
    }
  })
}

function events (miner) {
  const { fx } = miner
  const out = []
  const add = (Code, Description, Target = 'MINER') => out.push({
    Code, Description, Severity: 'Error', Target, CreatedAt: new Date().toISOString()
  })
  if (fx.boardsDown > 0) add('HASHBOARD_FAILURE', 'A hashboard stopped hashing.', 'BOARD')
  if (fx.psuFailed) add('PSU_FAILURE', 'The power supply reported a fault.')
  if (fx.fanLoss > 0) add('FAN_FAILURE', 'A fan is below its expected speed.', 'FAN')
  if (fx.controlBoard) add('CONTROL_BOARD_FAILURE', 'The control board reported an exception.')
  if (miner.overheating) add('OVERHEAT', 'Chips are above their temperature limit.')
  if (miner.activePool < 0 && miner.state === 'mining') add('NO_POOL', 'No pool is reachable.')
  return out
}

function poolRows (miner, sim) {
  return miner.pools.map((entry, index) => {
    const pool = sim.poolForUrl(entry.url)
    return {
      POOL: index,
      Priority: index,
      GROUP: 0,
      URL: entry.url,
      User: entry.user,
      Status: pool && !pool.fx.down && !miner.fx.netDown ? 'Alive' : 'Dead',
      'Stratum Active': index === miner.activePool,
      Accepted: entry.accepted,
      Rejected: entry.rejected,
      Stale: entry.stale,
      Quota: 1
    }
  })
}

function run (miner, sim, command, params) {
  if (SESSION_COMMANDS.has(command)) {
    const session = activeSession(miner)
    if (!session || params[0] !== session) return fail('Invalid session id')
    miner.luxSession.at = Date.now()
  }

  switch (command) {
    case 'version':
      return {
        ...status(22, 'LUXminer versions'),
        VERSION: [{ API: '3.7', CompileTime: 'sim', LUXminer: '2026.9.21.131955-sim', Miner: '2026.9.21.131955', Type: `Antminer ${miner.spec.name}` }]
      }
    case 'config':
      return {
        ...status(33, 'Configuration'),
        CONFIG: [{
          'ASC Count': miner.spec.boards,
          ControlBoardType: 'amlogic',
          Cooling: 'Air',
          CurtailMode: miner.suspended ? 'Sleep' : 'None',
          DHCP: true,
          Hostname: miner.id,
          IPAddr: sim.cfg.host,
          MACAddr: `d4:33:b2:00:${(miner.index >> 8).toString(16).padStart(2, '0')}:${(miner.index & 255).toString(16).padStart(2, '0')}`,
          Model: `Antminer ${miner.spec.name}`,
          NameplateTHS: miner.spec.nominalThs,
          OS: 'LuxOS',
          PSULabel: 'APW12',
          Profile: profileName(miner),
          SerialNumber: miner.serial,
          SystemStatus: 'Normal',
          GreenLed: 'auto',
          RedLed: miner.led ? 'blink' : 'auto'
        }]
      }
    case 'summary': {
      const counters = poolCounters(miner)
      return {
        ...status(11, 'Summary'),
        SUMMARY: [{
          Accepted: counters.accepted,
          Rejected: counters.rejected,
          Stale: counters.stale,
          Elapsed: elapsed(miner, sim),
          'GHS 5s': round(miner.ths * 1000),
          'GHS 30m': round(miner.ema.m15 * 1000),
          'GHS av': round(miner.ema.m5 * 1000),
          'Hardware Errors': Math.floor(miner.hwErrors)
        }]
      }
    }
    case 'devs':
      return { ...status(9, `${miner.spec.boards} ASC(s)`), DEVS: boardRows(miner) }
    case 'pools':
      return { ...status(7, `${miner.pools.length} Pool(s)`), POOLS: poolRows(miner, sim) }
    case 'temps':
      return {
        ...status(201, 'Temps'),
        METADATA: [{ BottomLeft: { Label: 'Board Outlet' }, BottomRight: { Label: 'Chip Outlet' }, TopLeft: { Label: 'Board Inlet' }, TopRight: { Label: 'Chip Inlet' } }],
        TEMPS: Array.from({ length: miner.spec.boards }, (_, id) => ({
          ID: id,
          TEMP: id,
          TopLeft: round(miner.inletC, 1),
          TopRight: round(miner.chipC - 8, 1),
          BottomLeft: round(miner.chipC - 12, 1),
          BottomRight: round(miner.tMaxC, 1)
        }))
      }
    case 'fans':
      return {
        ...status(202, `${FAN_COUNT} Fan(s)`),
        FANS: Array.from({ length: FAN_COUNT }, (_, id) => ({
          FAN: `J${12 + id}`,
          ID: id,
          RPM: Math.round(miner.fanPct * (1 - miner.fx.fanLoss) * 62),
          Speed: Math.round(miner.fanPct)
        }))
      }
    case 'power':
      return { ...status(311, 'Power usage'), POWER: [{ PSU: !miner.fx.psuFailed, Watts: Math.round(miner.powerW) }] }
    case 'events':
      return { ...status(357, 'Miner Events'), EVENTS: events(miner) }
    case 'profiles':
      return { ...status(323, 'List profiles'), PROFILES: Object.keys(PROFILES).map((name) => ({ 'Profile Name': name })) }
    case 'session':
      return { ...status(319, 'Session information'), SESSION: [{ SessionID: activeSession(miner) }] }
    case 'logon': {
      if (activeSession(miner)) return fail('Another session is active')
      const id = `${miner.index.toString(36)}s${Math.random().toString(36).slice(2, 10)}`
      miner.luxSession = { id, at: Date.now() }
      return { ...status(316, 'Session created'), SESSION: [{ SessionID: id }] }
    }
    case 'logoff':
      miner.luxSession = null
      return status(317, 'Session dropped')
    case 'rebootdevice':
      sim.minerCommand(miner.id, 'reboot', undefined, 'luxos')
      return status(328, 'Rebooting device')
    case 'ledset': {
      const [, color, mode] = params
      if (!['red', 'green'].includes(color) || !['auto', 'on', 'off', 'blink'].includes(mode)) return fail('Invalid LED parameters')
      if (color === 'red') sim.minerCommand(miner.id, 'led', mode === 'blink' || mode === 'on', 'luxos')
      return status(320, 'LED mode set')
    }
    case 'curtail': {
      const action = params[1]
      if (action !== 'sleep' && action !== 'wakeup') return fail('Invalid curtail action')
      sim.minerCommand(miner.id, action === 'sleep' ? 'sleep' : 'wake', undefined, 'luxos')
      return { ...status(335, 'Curtailment command sent'), CURTAIL: [{ Action: action === 'sleep' ? 'sleep mode' : 'wake up' }] }
    }
    case 'profileset': {
      const name = params[1]
      if (!Object.hasOwn(PROFILES, name)) return fail(`Profile not found: ${name}`)
      sim.minerCommand(miner.id, 'mode', PROFILES[name], 'luxos')
      return { ...status(321, 'Profile Set'), PROFILE: [{ Profile: name }] }
    }
    case 'addpool': {
      const [url, user, password = ''] = params
      if (!url || !user) return fail('Invalid pool parameters')
      // Pushed rather than replaced, so pools that stay keep their counters.
      miner.pools.push({ url, user, password, accepted: 0, rejected: 0, stale: 0, shareFraction: 0, rejectFraction: 0, staleFraction: 0 })
      sim.log('info', 'luxos', `pool added on ${miner.id}: ${url}`)
      return status(55, `Added pool ${miner.pools.length - 1}: '${url}'`)
    }
    case 'removepool': {
      const id = Number(params[0])
      if (!Number.isInteger(id) || id < 0 || id >= miner.pools.length) return fail(`Invalid pool id ${params[0]}`)
      miner.pools.splice(id, 1)
      return status(68, `Removed pool ${id}`)
    }
    default:
      return fail(`Invalid command: ${command}`)
  }
}

function respond (miner, sim, request) {
  const { command, parameter } = request || {}
  if (typeof command !== 'string') return fail('Missing command')
  if (command.includes('+')) {
    if (parameter !== undefined) return fail('Multiple commands take no parameter')
    const result = { id: 1 }
    for (const name of command.split('+')) result[name] = [run(miner, sim, name, [])]
    return result
  }
  return run(miner, sim, command, typeof parameter === 'string' ? parameter.split(',') : [])
}

module.exports = { respond }
