// Builds the panel's site state from what MDK reports, and compares it with what the
// simulator knows is true. No browser code here, so it runs under Node's test runner.

const STALE_MS = 5000
const HASH_TOLERANCE = 0.15
const HASH_FLOOR_THS = 5
const TEMP_TOLERANCE_C = 10

// MDK knows nothing about the clock, prices or utility limits, so those stay with
// the panel. Anything MDK could report comes only from MDK.
export function mergeView (state, view, memory = {}, now = Date.now()) {
  const { sensors = {}, meter } = view
  const dead = Boolean(meter?.dead)
  // Workers cache, so a few miners can still read as mining after the supply has gone.
  // Zero volts at the meter settles it, for the totals as well as the 3D view.
  const miners = dead ? view.miners.map((m) => ({ ...m, s: 'off', ths: 0, w: 0 })) : view.miners
  const inlets = memory.inlets ||= {}

  const containers = state.containers.map((container) => {
    const inside = miners.filter((m) => m.c === container.id)
    const readings = sensors[container.id] ?? {}
    const channel = (name) => readings[name]?.temp ?? null
    const inlet = channel('inlet')
    if (inlet !== null) inlets[container.id] = inlet
    const inletC = inlets[container.id] ?? 0
    const configured = view.containers?.find((c) => c.id === container.id)
    const capacityKw = configured?.capacityKw ?? container.capacityKw
    return {
      id: container.id,
      name: container.name,
      inletC,
      exhaustC: channel('exhaust') ?? inletC,
      heatKw: inside.reduce((sum, m) => sum + m.w, 0) / 1000,
      capacityKw,
      availableKw: capacityKw,
      coolingKw: 0,
      fx: {
        coolingLoss: 0,
        pduOff: false,
        // All silent with the supply up is all MDK can tell: it can't say why.
        netDown: !dead && inside.length > 0 && inside.every((m) => !m.net),
        sensorFault: Object.values(readings).some((r) => r.fault)
      }
    }
  })

  const counts = { mining: 0, sleeping: 0, booting: 0, off: 0, tripped: 0, failed: 0, unreachable: 0 }
  for (const m of miners) {
    if (!m.net) counts.unreachable++
    else if (counts[m.s] !== undefined) counts[m.s]++
  }
  if (dead) Object.assign(counts, { mining: 0, sleeping: 0, booting: 0, failed: 0, unreachable: 0, off: miners.length })

  const hashThs = miners.reduce((sum, m) => sum + m.ths, 0)
  const temps = miners.filter((m) => m.net).map((m) => m.temp)
  const itKw = miners.reduce((sum, m) => sum + m.w, 0) / 1000

  return {
    ...state,
    miners,
    containers,
    site: {
      ...state.site,
      hashThs,
      creditedThs: null,
      powerKw: meter?.powerKw ?? itKw,
      itKw,
      // A utility's limit isn't an MDK reading.
      limitKw: null,
      overLimit: false,
      overBreakerSec: 0,
      gridDown: dead,
      breakerOpen: false,
      avgChipC: temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : 0,
      maxChipC: temps.length ? Math.max(...temps) : 0,
      counts
    },
    source: 'mdk',
    ageMs: now - view.at,
    stale: now - view.at > STALE_MS
  }
}

function category (m) {
  if (!m.net || m.s === 'off' || m.s === 'booting' || m.s === 'unknown') return 'away'
  if (m.s === 'tripped' || m.s === 'failed') return 'down'
  return m.s
}

// Where MDK's picture differs from the truth, with the reason in plain words.
export function compareMiners (truth, reported) {
  const byId = new Map(reported.map((m) => [m.id, m]))
  const diffs = []

  for (const real of truth) {
    const seen = byId.get(real.id)
    if (!seen) {
      diffs.push({ id: real.id, why: 'not in MDK' })
      continue
    }
    const why = []
    const realState = category(real)
    const seenState = category(seen)
    if (realState !== seenState) {
      why.push(`MDK says ${seenState === 'away' ? 'no answer' : seenState}, really ${realState === 'away' ? 'unreachable' : realState}`)
    }
    if (realState === 'mining' && seenState === 'mining') {
      const gap = Math.abs(real.ths - seen.ths)
      if (gap > HASH_FLOOR_THS && gap > real.ths * HASH_TOLERANCE) {
        why.push(`hashrate ${seen.ths.toFixed(0)} vs really ${real.ths.toFixed(0)} TH/s`)
      }
      if (Math.abs(real.temp - seen.temp) > TEMP_TOLERANCE_C) {
        why.push(`temperature ${seen.temp.toFixed(0)} vs really ${real.temp.toFixed(0)}°C`)
      }
    }
    // A miner that's offline can't report its faults, so that alone isn't a gap.
    if (seen.net && real.flt.length && !seen.flt.length) {
      why.push(`fault not reported: ${real.flt.join(', ')}`)
    }
    if (why.length) diffs.push({ id: real.id, why: why.join('; ') })
  }
  return { total: truth.length, agree: truth.length - diffs.length, diffs }
}

// Whether a view describes the same miners as the current fleet.
export function viewMatchesFleet (state, view) {
  if (state.miners.length !== view.miners.length) return false
  const ids = new Set(view.miners.map((m) => m.id))
  return state.miners.every((m) => ids.has(m.id))
}
