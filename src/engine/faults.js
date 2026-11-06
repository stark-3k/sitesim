'use strict'

// Each fault declares what it targets and how it changes the model. Effects are
// recomputed from the active list, so clearing a fault can't leave state behind.
const CATALOG = {
  fan_failure: {
    label: 'Fan failure',
    scope: 'miner',
    description: 'Lost airflow. Chips heat up, throttle, then trip the thermal cut-out.',
    params: [{ name: 'severity', label: 'Airflow lost', min: 0.1, max: 1, step: 0.1, default: 1, format: 'percent' }],
    apply: (fx, p) => { fx.fanLoss = Math.max(fx.fanLoss, p.severity) }
  },
  hashboard_failure: {
    label: 'Hashboard failure',
    scope: 'miner',
    description: 'Boards stop hashing. Hashrate and power both fall by a third per board.',
    params: [{ name: 'boards', label: 'Boards down', min: 1, max: 3, step: 1, default: 1 }],
    apply: (fx, p) => { fx.boardsDown = Math.max(fx.boardsDown, p.boards) }
  },
  psu_failure: {
    label: 'PSU failure',
    scope: 'miner',
    description: 'The miner stops and reports a power fault until repaired.',
    params: [],
    apply: (fx) => { fx.psuFailed = true }
  },
  chip_degradation: {
    label: 'Chip degradation',
    scope: 'miner',
    description: 'Same power, less hashrate, rising hardware errors. Efficiency worsens.',
    params: [{ name: 'severity', label: 'Hashrate lost', min: 0.05, max: 0.6, step: 0.05, default: 0.15, format: 'percent' }],
    apply: (fx, p) => { fx.chipLoss = Math.max(fx.chipLoss, p.severity) }
  },
  firmware_hang: {
    label: 'Firmware hang',
    scope: 'miner',
    description: 'Draws full power, answers the API, produces no hashrate. A reboot clears it.',
    params: [],
    clearedByReboot: true,
    apply: (fx) => { fx.hang = true }
  },
  network_loss: {
    label: 'Network loss',
    scope: 'miner',
    description: 'The API stops answering and the miner cannot reach any pool.',
    params: [],
    apply: (fx) => { fx.netDown = true }
  },
  network_latency: {
    label: 'Slow network',
    scope: 'miner',
    description: 'API replies are delayed, which exercises Worker timeouts.',
    params: [{ name: 'delayMs', label: 'Delay', min: 100, max: 20000, step: 100, default: 3000, unit: 'ms' }],
    apply: (fx, p) => { fx.netDelayMs = Math.max(fx.netDelayMs, p.delayMs) }
  },
  control_board_fault: {
    label: 'Control board fault',
    scope: 'miner',
    description: 'Keeps mining but reports a control board exception.',
    params: [],
    apply: (fx) => { fx.controlBoard = true }
  },
  cooling_failure: {
    label: 'Cooling failure',
    scope: 'container',
    description: 'Removes cooling capacity. Inlet temperature rises for the whole container.',
    params: [{ name: 'severity', label: 'Capacity lost', min: 0.1, max: 1, step: 0.05, default: 0.4, format: 'percent' }],
    apply: (fx, p) => { fx.coolingLoss = Math.max(fx.coolingLoss, p.severity) }
  },
  pdu_trip: {
    label: 'PDU trip',
    scope: 'container',
    description: 'Cuts power to one container. Its miners reboot when power returns.',
    params: [],
    apply: (fx) => { fx.pduOff = true }
  },
  switch_failure: {
    label: 'Network switch failure',
    scope: 'container',
    description: 'A whole container drops off the network and loses its pools.',
    params: [],
    apply: (fx) => { fx.netDown = true }
  },
  sensor_fault: {
    label: 'Sensor fault',
    scope: 'container',
    description: 'The Seneca sensor reports its 850°C error value on all channels.',
    params: [],
    apply: (fx) => { fx.sensorFault = true }
  },
  grid_outage: {
    label: 'Grid outage',
    scope: 'site',
    description: 'Total power loss. The fleet reboots when the fault clears.',
    params: [],
    apply: (fx) => { fx.gridDown = true }
  },
  grid_curtailment: {
    label: 'Curtailment request',
    scope: 'site',
    description: 'Lowers the allowed power. Nothing sheds load automatically: going over costs a penalty.',
    params: [{ name: 'limit', label: 'Allowed share of contract', min: 0.1, max: 0.95, step: 0.05, default: 0.6, format: 'percent' }],
    apply: (fx, p) => { fx.limitFactor = Math.min(fx.limitFactor, p.limit) }
  },
  grid_alert: {
    label: 'Grid alert',
    scope: 'site',
    description: 'The grid operator warns of stress and asks sites to stand by. At 100% it is only a warning, and below that it also lowers the allowed power.',
    params: [{ name: 'limit', label: 'Allowed share of contract', min: 0.1, max: 1, step: 0.05, default: 1, format: 'percent' }],
    apply: (fx, p) => {
      fx.gridAlert = true
      fx.limitFactor = Math.min(fx.limitFactor, p.limit)
    }
  },
  heatwave: {
    label: 'Heatwave',
    scope: 'site',
    description: 'Raises outdoor temperature, which also derates cooling above 35°C.',
    params: [{ name: 'deltaC', label: 'Added heat', min: 2, max: 30, step: 1, default: 14, unit: '°C' }],
    apply: (fx, p) => { fx.ambientDeltaC += p.deltaC }
  },
  price_spike: {
    label: 'Power price spike',
    scope: 'site',
    description: 'Multiplies the electricity price.',
    params: [{ name: 'mult', label: 'Multiplier', min: 1.5, max: 20, step: 0.5, default: 4, unit: '×' }],
    apply: (fx, p) => { fx.priceMult *= p.mult }
  },
  revenue_drop: {
    label: 'Revenue drop',
    scope: 'site',
    description: 'Lowers BTC earned per TH/day, as a difficulty jump would.',
    params: [{ name: 'mult', label: 'Revenue kept', min: 0.1, max: 0.95, step: 0.05, default: 0.6, format: 'percent' }],
    apply: (fx, p) => { fx.revenueMult *= p.mult }
  },
  meter_frozen: {
    label: 'Power meter frozen',
    scope: 'site',
    description: 'The SATEC meter keeps returning its last reading.',
    params: [],
    apply: (fx) => { fx.meterFrozen = true }
  },
  pool_outage: {
    label: 'Pool outage',
    scope: 'pool',
    description: 'Miners fail over to their next live pool. Optionally takes the pool API down too.',
    params: [{ name: 'apiDown', label: 'API down too', min: 0, max: 1, step: 1, default: 0, format: 'toggle' }],
    apply: (fx, p) => {
      fx.down = true
      if (p.apiDown) fx.apiDown = true
    }
  },
  pool_degraded: {
    label: 'Pool degraded',
    scope: 'pool',
    description: 'More stale and rejected shares, so credited hashrate falls below actual.',
    params: [
      { name: 'staleRate', label: 'Stale rate', min: 0, max: 0.5, step: 0.01, default: 0.06, format: 'percent' },
      { name: 'rejectRate', label: 'Reject rate', min: 0, max: 0.5, step: 0.01, default: 0.03, format: 'percent' }
    ],
    apply: (fx, p) => {
      fx.staleRate = Math.max(fx.staleRate, p.staleRate)
      fx.rejectRate = Math.max(fx.rejectRate, p.rejectRate)
    }
  }
}

const CHAOS_TYPES = [
  ['fan_failure', 3],
  ['hashboard_failure', 3],
  ['psu_failure', 2],
  ['chip_degradation', 3],
  ['firmware_hang', 2],
  ['network_loss', 2],
  ['control_board_fault', 1]
]

function resolveParams (type, params = {}) {
  const def = CATALOG[type]
  const out = {}
  for (const spec of def.params) {
    const raw = params[spec.name] ?? spec.default
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new Error(`ERR_FAULT_PARAM_INVALID: ${spec.name}`)
    out[spec.name] = Math.min(spec.max, Math.max(spec.min, value))
  }
  return out
}

function publicCatalog () {
  return Object.entries(CATALOG).map(([id, def]) => ({
    id,
    label: def.label,
    scope: def.scope,
    description: def.description,
    params: def.params
  }))
}

module.exports = { CATALOG, CHAOS_TYPES, resolveParams, publicCatalog }
