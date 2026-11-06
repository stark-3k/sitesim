'use strict'

/* global EventSource, ResizeObserver */

const $ = (id) => document.getElementById(id)

const STATE_COLORS = {
  mining: '#4fb477',
  sleeping: '#5fa8d3',
  booting: '#a78bda',
  off: '#3c3932',
  tripped: '#e5604d',
  failed: '#e5604d',
  hot: '#e3b341',
  offline: '#6f695f'
}

const STATE_LABELS = [
  ['mining', 'Mining'],
  ['hot', 'Too hot'],
  ['sleeping', 'Sleeping'],
  ['booting', 'Booting'],
  ['tripped', 'Tripped or failed'],
  ['offline', 'No network'],
  ['off', 'No power']
]

const SERIES = {
  hash: { el: 'chart-hash', legend: 'legend-hash', lines: [
    { key: 'hash', label: 'Actual', color: '#f7931a', scale: 1e-3, digits: 2 },
    { key: 'credited', label: 'Credited by pool', color: '#4fb477', scale: 1e-3, digits: 2 }
  ] },
  power: { el: 'chart-power', legend: 'legend-power', zero: true, lines: [
    { key: 'power', label: 'Site', color: '#5fa8d3', digits: 0 },
    { key: 'limit', label: 'Limit', color: '#e5604d', dashed: true, digits: 0 }
  ] },
  temp: { el: 'chart-temp', legend: 'legend-temp', lines: [
    { key: 'chipMax', label: 'Hottest chip', color: '#e5604d', digits: 0 },
    { key: 'chipAvg', label: 'Avg chip', color: '#f7931a', digits: 0 },
    { key: 'inlet', label: 'Inlet', color: '#e3b341', digits: 0 },
    { key: 'ambient', label: 'Outdoor', color: '#5fa8d3', digits: 0 }
  ] },
  econ: { el: 'chart-econ', legend: 'legend-econ', lines: [
    { key: 'revenueRate', label: 'Revenue', color: '#4fb477', digits: 1 },
    { key: 'costRate', label: 'Power cost', color: '#e5604d', digits: 1 }
  ] }
}

const ui = {
  state: null,
  catalog: null,
  metric: 'state',
  windowSec: 21600,
  selectedMiner: null,
  events: [],
  history: [],
  cells: new Map(),
  fleetBuilt: false,
  hover: new Map()
}

// --- API ------------------------------------------------------------------

async function api (path, body) {
  const res = await fetch(path, body === undefined
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

// Actions report failures in the log panel, where they will be seen.
function act (path, body) {
  return api(path, body).catch((err) => {
    ui.events.unshift({ seq: -Date.now(), t: ui.state?.t || 0, level: 'error', source: 'panel', message: friendlyError(err) })
    renderEvents()
  })
}

function friendlyError (err) {
  return String(err.message || err).replace(/^ERR_/, '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
}

// --- formatting -----------------------------------------------------------

const fmtHash = (ths) => ths >= 1000 ? [(ths / 1000).toFixed(2), 'PH/s'] : [ths.toFixed(0), 'TH/s']
const usd = (value, digits = 2) => `${value < 0 ? '−' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`

function clockText (sec, startHour) {
  const total = startHour * 3600 + sec
  const day = Math.floor(total / 86400) + 1
  const left = total % 86400
  const h = String(Math.floor(left / 3600)).padStart(2, '0')
  const m = String(Math.floor((left % 3600) / 60)).padStart(2, '0')
  return { day, text: `${h}:${m}` }
}

function eventTime (t) {
  const { clock } = ui.state
  const start = clock.elapsedSec
  const nowTotal = clock.day * 86400 - 86400 + clock.hour * 3600 + clock.minute * 60
  const total = nowTotal - (start - t)
  const day = Math.floor(total / 86400) + 1
  const left = ((total % 86400) + 86400) % 86400
  return `D${day} ${String(Math.floor(left / 3600)).padStart(2, '0')}:${String(Math.floor((left % 3600) / 60)).padStart(2, '0')}`
}

const durationText = (sec) => {
  if (sec >= 3600) return `${(sec / 3600).toFixed(sec % 3600 ? 1 : 0)}h`
  return `${Math.round(sec / 60)}m`
}

function escapeHtml (value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// --- colour scales --------------------------------------------------------

function lerpColor (stops, x) {
  const v = Math.min(1, Math.max(0, x)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(v))
  const f = v - i
  const a = stops[i]
  const b = stops[i + 1]
  return `rgb(${a.map((c, k) => Math.round(c + (b[k] - c) * f)).join(',')})`
}

const TEMP_STOPS = [[40, 90, 150], [70, 170, 120], [230, 180, 60], [229, 96, 77], [255, 60, 60]]
const LOAD_STOPS = [[45, 42, 37], [120, 90, 40], [247, 147, 26]]

function cellColor (m) {
  if (ui.metric === 'temp') return m.s === 'off' ? STATE_COLORS.off : lerpColor(TEMP_STOPS, (m.temp - 45) / 55)
  if (ui.metric === 'hash') return lerpColor(LOAD_STOPS, m.ths / (m.nth * 1.1))
  if (ui.metric === 'power') return lerpColor(LOAD_STOPS, m.w / (m.nw * 1.2))
  if (ui.metric === 'model') return modelInfo(m.model)?.color || STATE_COLORS.offline
  if (m.s === 'off') return STATE_COLORS.off
  if (!m.net) return STATE_COLORS.offline
  if (m.s === 'tripped' || m.s === 'failed') return STATE_COLORS.tripped
  if (m.s === 'booting') return STATE_COLORS.booting
  if (m.s === 'sleeping') return STATE_COLORS.sleeping
  if (m.hot) return STATE_COLORS.hot
  return STATE_COLORS.mining
}

const modelInfo = (id) => ui.catalog?.models.find((model) => model.id === id)

function renderLegend () {
  const html = legendHtml()
  $('legend').innerHTML = html
  $('legend-3d').innerHTML = html
}

function legendHtml () {
  const fault = '<span>Marked = active fault</span>'
  if (ui.metric === 'model') {
    const inFleet = new Set(ui.state?.miners.map((m) => m.model))
    return (ui.catalog?.models || []).filter((m) => inFleet.has(m.id)).map((m) => `<span><i style="background:${m.color}"></i>${escapeHtml(m.brand)}</span>`).join('') + fault
  }
  if (ui.metric === 'state') {
    return STATE_LABELS.map(([key, label]) => `<span><i style="background:${STATE_COLORS[key]}"></i>${label}</span>`).join('') + fault
  }
  const stops = ui.metric === 'temp' ? TEMP_STOPS : LOAD_STOPS
  const css = stops.map((c) => `rgb(${c.join(',')})`).join(',')
  const [lo, hi] = { temp: ['45°C', '100°C'], hash: ['0', '110% of rated'], power: ['0', '120% of rated'] }[ui.metric]
  return `<span>${lo}</span><i class="ramp" style="background:linear-gradient(90deg,${css})"></i><span>${hi}</span>${fault}`
}

// --- fleet ----------------------------------------------------------------

function buildFleet (state) {
  const root = $('fleet')
  root.innerHTML = ''
  ui.cells.clear()
  for (const container of state.containers) {
    const block = document.createElement('div')
    block.className = 'container-block'
    block.innerHTML = `<div class="container-head"><strong>${escapeHtml(container.name)}</strong><span id="head-${container.id}"></span></div>`
    const grid = document.createElement('div')
    grid.className = 'grid'
    for (const miner of state.miners.filter((m) => m.c === container.id)) {
      const cell = document.createElement('button')
      cell.type = 'button'
      cell.className = 'cell'
      cell.dataset.id = miner.id
      grid.append(cell)
      ui.cells.set(miner.id, cell)
    }
    block.append(grid)
    root.append(block)
  }
  ui.fleetBuilt = true
}

function renderFleet (state) {
  if (!ui.fleetBuilt) buildFleet(state)
  for (const m of state.miners) {
    const cell = ui.cells.get(m.id)
    if (!cell) continue
    cell.style.backgroundColor = cellColor(m)
    cell.classList.toggle('faulted', m.flt.length > 0)
    cell.setAttribute('aria-label', `${m.id}: ${m.s}, ${m.temp} degrees, ${m.ths} TH/s${m.flt.length ? `, faults: ${m.flt.join(', ')}` : ''}`)
    cell.title = `${m.id} · ${modelInfo(m.model)?.brand || m.model} · ${m.s} · ${m.temp.toFixed(0)}°C · ${m.ths.toFixed(0)} TH/s · ${(m.w / 1000).toFixed(2)} kW${m.flt.length ? ` · ${m.flt.join(', ')}` : ''}`
  }
  for (const c of state.containers) {
    const head = $(`head-${c.id}`)
    if (head) head.textContent = `Inlet ${c.inletC.toFixed(1)}°C · ${c.heatKw.toFixed(0)} kW heat`
  }
}

// --- KPIs and banner ------------------------------------------------------

function setValue (id, value, unit, tone) {
  const el = $(id)
  el.innerHTML = `${escapeHtml(value)}${unit ? `<small>${escapeHtml(unit)}</small>` : ''}`
  el.className = `kpi-value ${tone || ''}`
}

function renderKpis (state) {
  const { site, env, economics: eco } = state
  const counts = site.counts
  const total = state.miners.length

  const [hash, hashUnit] = fmtHash(site.hashThs)
  setValue('kpi-hash', hash, hashUnit)
  const lost = site.hashThs > 0 ? 1 - site.creditedThs / site.hashThs : 0
  $('kpi-hash-sub').innerHTML = site.hashThs > 0 && lost > 0.5
    ? '<span class="bad">No pool is crediting this work</span>'
    : `${fmtHash(site.creditedThs).join(' ')} credited`

  const load = site.limitKw > 0 ? site.powerKw / site.limitKw : 0
  setValue('kpi-power', site.powerKw.toFixed(0), 'kW', site.overLimit ? 'bad' : '')
  const bar = $('kpi-power-bar')
  bar.style.width = `${Math.min(100, load * 100)}%`
  bar.className = load > 1 ? 'bad' : load > 0.92 ? 'warn' : ''
  $('kpi-power-sub').textContent = `Limit ${site.limitKw.toFixed(0)} kW · $${env.priceUsdKwh.toFixed(3)}/kWh`

  setValue('kpi-temp', site.maxChipC.toFixed(0), '°C hottest', site.maxChipC >= 92 ? 'bad' : site.maxChipC >= 85 ? 'warn' : '')
  $('kpi-temp-sub').textContent = `Avg ${site.avgChipC.toFixed(0)}°C · Outdoor ${env.ambientC.toFixed(0)}°C`

  const trouble = counts.tripped + counts.failed
  setValue('kpi-fleet', `${counts.mining}/${total}`, 'mining', trouble ? 'warn' : '')
  const parts = []
  if (trouble) parts.push(`${trouble} down`)
  if (counts.sleeping) parts.push(`${counts.sleeping} asleep`)
  if (counts.booting) parts.push(`${counts.booting} booting`)
  if (counts.off) parts.push(`${counts.off} no power`)
  $('kpi-fleet-sub').textContent = parts.join(' · ') || 'All machines mining'

  const rate = eco.profitRateUsdH
  setValue('kpi-rate', usd(rate), '/h', rate < 0 ? 'bad' : 'good')
  $('kpi-rate-sub').textContent = `${usd(eco.revenueRateUsdH, 0)} in · ${usd(eco.costRateUsdH, 0)} power`

  setValue('kpi-profit', usd(eco.profitUsd), '', eco.profitUsd < 0 ? 'bad' : '')
  $('kpi-profit-sub').textContent = `${eco.btcEarned.toFixed(5)} BTC${eco.penaltyUsd > 0 ? ` · ${usd(eco.penaltyUsd)} penalties` : ''}`
}

function renderBanner (state) {
  const { site } = state
  const el = $('alert-banner')
  let html = ''
  if (site.breakerOpen) {
    html = 'Main breaker is open and the site is dark. <button class="btn btn-small" id="btn-breaker" type="button">Close breaker</button>'
  } else if (site.gridDown) {
    html = 'Grid outage: the site has no power.'
  } else if (site.overBreakerSec > 0) {
    html = `Overload: the breaker opens in ${Math.max(0, site.breakerTripSec - site.overBreakerSec)}s unless power falls below ${site.breakerKw} kW.`
  } else if (site.gridAlert) {
    html = `Grid alert: the grid operator is asking sites to stand by${site.overLimit ? `, and this site is over the limit by ${(site.powerKw - site.limitKw).toFixed(0)} kW` : ''}.`
  } else if (site.overLimit) {
    html = `Over the power limit by ${(site.powerKw - site.limitKw).toFixed(0)} kW, and penalties are accruing.`
  }
  if (el.dataset.html !== html) {
    el.dataset.html = html
    el.innerHTML = html
    el.hidden = !html
    const button = $('btn-breaker')
    if (button) button.onclick = () => act('/api/site', { resetBreaker: true })
  }
}

// --- transport ------------------------------------------------------------

function renderTransport (state) {
  const { clock, runtime } = state
  $('clock-time').textContent = `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`
  $('clock-day').textContent = `Day ${clock.day}`
  $('btn-pause').textContent = runtime.paused ? 'Resume' : 'Pause'

  const speeds = $('speeds')
  if (!speeds.children.length) {
    for (const speed of runtime.speeds) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = speed === 1 ? '1×' : speed === 3600 ? '1h/s' : speed === 1800 ? '30m/s' : speed === 300 ? '5m/s' : speed === 60 ? '1m/s' : `${speed}×`
      button.dataset.speed = speed
      speeds.append(button)
    }
  }
  for (const button of speeds.children) button.classList.toggle('active', Number(button.dataset.speed) === runtime.speed)

  const behind = !runtime.paused && runtime.actualSpeed > 0 && runtime.actualSpeed < runtime.speed * 0.8
  $('speed-note').textContent = behind ? `Running at ${Math.round(runtime.actualSpeed)}×` : ''
}

// --- side panels ----------------------------------------------------------

function renderScenarios (state) {
  const active = $('scenario-active')
  if (state.scenario) {
    const { name, goal, elapsedSec, durationSec } = state.scenario
    const pct = Math.min(100, 100 * elapsedSec / durationSec)
    active.hidden = false
    active.innerHTML = `<strong>${escapeHtml(name)}</strong><p>${escapeHtml(goal)}</p>
      <div class="progress"><span style="width:${pct}%"></span></div>
      <button class="btn btn-small" id="btn-stop-scenario" type="button">Stop</button>
      <span class="hint"> ${durationText(elapsedSec)} of ${durationText(durationSec)}</span>`
    $('btn-stop-scenario').onclick = () => act('/api/scenarios/stop', {})
  } else {
    active.hidden = true
  }

  const result = $('scenario-result')
  const r = state.scenarioResult
  if (r && !state.scenario) {
    result.hidden = false
    result.innerHTML = `<strong>${escapeHtml(r.name)}: ${escapeHtml(r.reason)}</strong>
      <div class="result-grid">
        <span>Revenue</span><b>${usd(r.revenueUsd)}</b>
        <span>Power cost</span><b>${usd(r.powerCostUsd)}</b>
        <span>Penalties</span><b>${usd(r.penaltyUsd)}</b>
        <span>Profit</span><b class="${r.profitUsd < 0 ? 'bad' : 'good'}">${usd(r.profitUsd)}</b>
      </div>`
  } else {
    result.hidden = true
  }
}

function renderCatalog () {
  const { scenarios, faults } = ui.catalog
  $('scenario-list').innerHTML = scenarios.map((s) => `
    <button type="button" class="scenario" data-scenario="${escapeHtml(s.id)}" title="${escapeHtml(s.goal)}">
      <span>${escapeHtml(s.name)}</span><small>${durationText(s.durationSec)}</small>
      <p>${escapeHtml(s.description)}</p>
    </button>`).join('')

  const groups = { miner: 'Miner', container: 'Container', site: 'Site', pool: 'Pool' }
  $('fault-type').innerHTML = Object.entries(groups).map(([scope, label]) => `
    <optgroup label="${label}">
      ${faults.filter((f) => f.scope === scope).map((f) => `<option value="${f.id}">${escapeHtml(f.label)}</option>`).join('')}
    </optgroup>`).join('')
  syncFaultForm()
}

const paramText = (spec, value) => {
  if (spec.format === 'percent') return `${Math.round(value * 100)}%`
  if (spec.format === 'toggle') return Number(value) ? 'Yes' : 'No'
  return `${value}${spec.unit ? ` ${spec.unit}` : ''}`
}

function targetOptions (scope) {
  const state = ui.state
  if (scope === 'miner') {
    return [
      ['random:1', '1 random miner'],
      ['random:5', '5 random miners'],
      ['percent:10', '10% of the fleet'],
      ['percent:30', '30% of the fleet'],
      ...state.containers.map((c) => [`container:${c.id}`, `All of ${c.name}`]),
      ...ui.catalog.models
        .filter((m) => state.miners.some((miner) => miner.model === m.id))
        .map((m) => [`model:${m.id}`, `All ${m.brand}`]),
      ['all', 'Whole fleet']
    ]
  }
  if (scope === 'container') return state.containers.map((c) => [c.id, c.name])
  if (scope === 'pool') return state.pools.map((p) => [`pool:${p.id}`, p.name])
  return []
}

function syncFaultForm () {
  const fault = ui.catalog.faults.find((f) => f.id === $('fault-type').value)
  if (!fault || !ui.state) return
  $('fault-desc').textContent = fault.description

  const options = targetOptions(fault.scope)
  $('fault-target-wrap').hidden = !options.length
  $('fault-target').innerHTML = options.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('')

  const params = $('fault-params')
  params.innerHTML = ''
  for (const spec of fault.params) {
    const label = document.createElement('label')
    const output = document.createElement('span')
    output.className = 'param-value'
    output.textContent = paramText(spec, spec.default)
    label.textContent = spec.label
    label.prepend(output)
    const input = document.createElement('input')
    input.type = 'range'
    input.name = spec.name
    input.min = spec.min
    input.max = spec.max
    input.step = spec.step
    input.value = spec.default
    input.oninput = () => { output.textContent = paramText(spec, input.value) }
    label.append(input)
    params.append(label)
  }
}

function renderFaults (state) {
  const groups = new Map()
  for (const fault of state.faults) {
    if (!groups.has(fault.groupId)) groups.set(fault.groupId, [])
    groups.get(fault.groupId).push(fault)
  }
  $('fault-count').textContent = groups.size ? `(${groups.size})` : ''
  $('btn-clear-all').hidden = !groups.size

  const key = [...groups.keys()].join(',') + (groups.size ? `@${Math.floor(state.t / 60)}` : '')
  const list = $('fault-list')
  if (list.dataset.key !== key) {
    list.dataset.key = key
    list.innerHTML = [...groups.entries()].map(([groupId, faults]) => {
      const fault = faults[0]
      const where = fault.scope === 'site' ? 'Site' : faults.length === 1 ? fault.target : `${faults.length} miners`
      const left = fault.expiresAt === null ? '' : ` · ${durationText(Math.max(0, fault.expiresAt - state.t))} left`
      return `<li><div>${escapeHtml(fault.label)}<br><small>${escapeHtml(where)}${left} · ${escapeHtml(fault.source)}</small></div>
        <button type="button" class="btn btn-small" data-clear-group="${groupId}">Clear</button></li>`
    }).join('')
  }
  const chaos = $('chaos')
  if (document.activeElement !== chaos) chaos.checked = state.chaos.enabled
  $('chaos-note').textContent = `${state.chaos.faultsPerMinerDay} per miner/day`
}

function renderPools (state) {
  $('pools').innerHTML = state.pools.map((p) => {
    const tag = p.down
      ? '<span class="tag tag-bad">Down</span>'
      : p.degraded
        ? '<span class="tag tag-warn">Degraded</span>'
        : p.workers > 0 ? '<span class="tag tag-ok">Active</span>' : '<span class="tag tag-idle">Standby</span>'
    const [hash, unit] = fmtHash(p.creditedThs)
    return `<div class="row"><div><strong>${escapeHtml(p.name)}</strong>${tag}<small>${p.workers} workers · ${p.btcTotal.toFixed(5)} BTC</small></div>
      <div class="num">${hash} ${unit}</div></div>`
  }).join('')
}

function renderContainers (state) {
  $('containers').innerHTML = state.containers.map((c) => {
    const flags = []
    if (c.fx.coolingLoss > 0) flags.push(`<span class="tag tag-bad">Cooling −${Math.round(c.fx.coolingLoss * 100)}%</span>`)
    if (c.fx.pduOff) flags.push('<span class="tag tag-bad">PDU off</span>')
    if (c.fx.netDown) flags.push('<span class="tag tag-bad">Switch down</span>')
    if (c.fx.sensorFault) flags.push('<span class="tag tag-warn">Sensor</span>')
    return `<div class="row"><div><strong>${escapeHtml(c.name)}</strong>${flags.join('')}
      <small>Inlet ${c.inletC.toFixed(1)}°C · Exhaust ${c.exhaustC.toFixed(1)}°C</small></div>
      <div class="num">${c.heatKw.toFixed(0)}/${c.availableKw.toFixed(0)} kW</div></div>`
  }).join('')
}

function renderModels (state) {
  const rows = new Map()
  for (const m of state.miners) {
    if (!rows.has(m.model)) rows.set(m.model, { count: 0, mining: 0, ths: 0, w: 0, hottest: 0 })
    const row = rows.get(m.model)
    row.count++
    if (m.s === 'mining') row.mining++
    row.ths += m.ths
    row.w += m.w
    row.hottest = Math.max(row.hottest, m.temp)
  }
  $('models').innerHTML = [...rows.entries()].map(([id, row]) => {
    const model = modelInfo(id)
    const [hash, unit] = fmtHash(row.ths)
    const tone = row.hottest >= 92 ? 'bad' : row.hottest >= 85 ? 'warn-text' : ''
    return `<tr>
      <td><i style="background:${model?.color || '#6f695f'}"></i>${escapeHtml(model?.brand || id)}<small>${escapeHtml(model?.name || '')}</small></td>
      <td class="n">${row.mining}/${row.count}</td>
      <td class="n">${hash} ${unit}</td>
      <td class="n">${(row.w / 1000).toFixed(1)} kW</td>
      <td class="n">${row.ths > 1 ? (row.w / row.ths).toFixed(1) : '–'}</td>
      <td class="n ${tone}">${row.hottest.toFixed(0)}°C</td>
    </tr>`
  }).join('')
}

function renderProtocols (state) {
  const labels = {
    ...Object.fromEntries((ui.catalog?.models || []).map((m) => [m.id, m.brand])),
    satec: 'SATEC meter',
    seneca: 'Seneca sensors',
    f2pool: 'F2Pool API'
  }
  $('protocols').innerHTML = Object.entries(labels).map(([key, label]) => {
    const p = state.runtime.protocols[key]
    const tag = p?.active ? '<span class="tag tag-ok">Polling</span>' : '<span class="tag tag-idle">Idle</span>'
    return `<div class="row"><div><strong>${label}</strong>${tag}</div><div class="num">${p ? p.requests.toLocaleString() : 0} req</div></div>`
  }).join('')
}

// Commands that arrived over a device protocol, so from a Worker and not the panel.
const DEVICE_SOURCES = new Set(['cgminer', 'antminer', 'whatsminer', 'sealminer', 'luxos', 'proto'])
const isDeviceSource = (source) => DEVICE_SOURCES.has(source)

function renderEvents () {
  const list = $('events')
  list.innerHTML = ui.events.slice(0, 200).map((e) => `
    <li class="${e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : ''}">
      <time>${ui.state ? eventTime(e.t) : ''}</time>
      <span class="src ${isDeviceSource(e.source) ? 'src-device' : ''}">${escapeHtml(e.source)}</span>
      <span>${escapeHtml(e.message)}</span>
    </li>`).join('')
}

function mergeEvents (state) {
  if (!state.events.length) return
  const lastSeq = ui.events.find((e) => e.seq > 0)?.seq || 0
  const fresh = state.events.filter((e) => e.seq > lastSeq)
  if (!fresh.length) return
  ui.events = [...fresh.reverse(), ...ui.events].slice(0, 300)
  renderEvents()
}

// --- charts ---------------------------------------------------------------

function fitCanvas (canvas) {
  const ratio = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  const width = Math.max(1, Math.round(rect.width * ratio))
  const height = Math.max(1, Math.round(rect.height * ratio))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  return { ctx, width: rect.width, height: rect.height }
}

function niceScale (min, max, zero) {
  if (zero) min = 0
  if (min === max) { min -= 1; max += 1 }
  const span = max - min
  const raw = span / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw
  return {
    lo: Math.floor(min / step) * step,
    hi: Math.ceil(max / step) * step,
    step
  }
}

function drawChart (spec) {
  const canvas = $(spec.el)
  const { ctx, width, height } = fitCanvas(canvas)
  const samples = ui.history
  const pad = { left: 38, right: 8, top: 6, bottom: 18 }
  const plotW = Math.max(1, width - pad.left - pad.right)
  const plotH = Math.max(1, height - pad.top - pad.bottom)
  ctx.clearRect(0, 0, width, height)

  const value = (sample, line) => sample[line.key] * (line.scale || 1)
  let min = Infinity
  let max = -Infinity
  for (const sample of samples) {
    for (const line of spec.lines) {
      const v = value(sample, line)
      if (v < min) min = v
      if (v > max) max = v
    }
  }

  ctx.font = '10.5px ui-monospace, Menlo, monospace'
  if (!samples.length) {
    ctx.fillStyle = '#6f695f'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText('Collecting data…', pad.left, pad.top + 16)
    renderChartLegend(spec, null)
    return
  }

  const y = niceScale(min, max, spec.zero)
  const now = ui.state ? ui.state.t : samples[samples.length - 1].t
  const start = ui.windowSec ? now - ui.windowSec : samples[0].t
  const xFor = (t) => pad.left + ((t - start) / Math.max(1, now - start)) * plotW
  const yFor = (v) => pad.top + (1 - (v - y.lo) / Math.max(1e-9, y.hi - y.lo)) * plotH

  ctx.strokeStyle = '#2b2823'
  ctx.fillStyle = '#7d766b'
  ctx.lineWidth = 1
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (let v = y.lo; v <= y.hi + y.step / 2; v += y.step) {
    const py = Math.round(yFor(v)) + 0.5
    ctx.beginPath()
    ctx.moveTo(pad.left, py)
    ctx.lineTo(width - pad.right, py)
    ctx.stroke()
    ctx.fillText(Number.isInteger(y.step) ? v.toFixed(0) : v.toFixed(y.step < 0.1 ? 2 : 1), pad.left - 5, py)
  }

  const startHour = ui.state ? ui.state.clock.startHour : 0
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const ticks = Math.max(2, Math.floor(plotW / 70))
  for (let i = 0; i <= ticks; i++) {
    const t = start + (now - start) * i / ticks
    if (t < 0) continue
    const px = pad.left + plotW * i / ticks
    ctx.textAlign = i === 0 ? 'left' : i === ticks ? 'right' : 'center'
    ctx.fillText(clockText(t, startHour).text, px, height - pad.bottom + 5)
  }

  ctx.save()
  ctx.beginPath()
  ctx.rect(pad.left, pad.top, plotW, plotH)
  ctx.clip()
  for (const line of [...spec.lines].reverse()) {
    ctx.strokeStyle = line.color
    ctx.lineWidth = 1.5
    ctx.setLineDash(line.dashed ? [5, 4] : [])
    ctx.beginPath()
    let started = false
    for (const sample of samples) {
      if (sample.t < start) continue
      const px = xFor(sample.t)
      const py = yFor(value(sample, line))
      if (started) ctx.lineTo(px, py)
      else ctx.moveTo(px, py)
      started = true
    }
    ctx.stroke()
  }
  ctx.restore()
  ctx.setLineDash([])

  const hoverX = ui.hover.get(spec.el)
  let shown = samples[samples.length - 1]
  if (hoverX !== undefined && hoverX >= pad.left && hoverX <= width - pad.right) {
    const t = start + ((hoverX - pad.left) / plotW) * (now - start)
    shown = samples.reduce((best, sample) => Math.abs(sample.t - t) < Math.abs(best.t - t) ? sample : best, samples[0])
    const px = xFor(shown.t)
    ctx.strokeStyle = '#6f695f'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(px, pad.top)
    ctx.lineTo(px, pad.top + plotH)
    ctx.stroke()
    for (const line of spec.lines) {
      ctx.fillStyle = line.color
      ctx.beginPath()
      ctx.arc(px, yFor(value(shown, line)), 2.5, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  renderChartLegend(spec, shown)
}

function renderChartLegend (spec, sample) {
  $(spec.legend).innerHTML = spec.lines.map((line) => {
    const v = sample ? (sample[line.key] * (line.scale || 1)).toFixed(line.digits) : '–'
    return `<span><i style="background:${line.color}"></i>${line.label}<b>${v}</b></span>`
  }).join('')
}

function drawCharts () {
  for (const spec of Object.values(SERIES)) drawChart(spec)
}

async function refreshHistory () {
  try {
    const canvasWidth = $('chart-hash').getBoundingClientRect().width || 400
    const points = Math.min(1000, Math.max(120, Math.round(canvasWidth)))
    const { samples } = await api(`/api/history?window=${ui.windowSec}&points=${points}`)
    ui.history = samples
    drawCharts()
  } catch {
    // The connection indicator already shows when the simulator is unreachable.
  }
}

// --- miner dialog ---------------------------------------------------------

function sparkline (values, color, label) {
  if (values.length < 2) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const points = values.map((v, i) => `${(i / (values.length - 1) * 100).toFixed(2)},${(38 - (v - min) / span * 36).toFixed(2)}`).join(' ')
  return `<div class="spark-label">${label}: ${values[values.length - 1]} (range ${min}–${max})</div>
    <svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="${label} trend">
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    </svg>`
}

async function renderMiner () {
  const id = ui.selectedMiner
  if (!id) return
  let m
  try {
    m = await api(`/api/miners/${encodeURIComponent(id)}`)
  } catch {
    return
  }
  const body = $('miner-body')
  const scroll = $('miner-dialog').scrollTop
  const eff = m.efficiency === null ? '–' : `${m.efficiency.toFixed(1)} W/TH`
  const minerFaults = ui.catalog.faults.filter((f) => f.scope === 'miner')
  const selected = $('miner-fault')?.value

  body.innerHTML = `
    <div class="dialog-head">
      <h2>${escapeHtml(m.id)}</h2>
      <button type="button" class="btn btn-small btn-quiet" data-close>Close</button>
    </div>
    <p class="hint">${escapeHtml(m.brand)} ${escapeHtml(m.modelName)} · ${escapeHtml(m.protocol)}</p>
    <p class="hint mono">${escapeHtml(m.serial)} · ${escapeHtml(m.address)}:${m.port}</p>
    <div class="stats" style="margin-top:10px">
      <div><span>Status</span><b>${escapeHtml(m.s)}</b></div>
      <div><span>Hashrate</span><b>${m.ths.toFixed(1)} TH/s</b></div>
      <div><span>Power</span><b>${(m.w / 1000).toFixed(2)} kW</b></div>
      <div><span>Chip</span><b>${m.temp.toFixed(1)}°C</b></div>
      <div><span>Inlet</span><b>${m.inletC.toFixed(1)}°C</b></div>
      <div><span>Fan</span><b>${m.fan}%</b></div>
      <div><span>Efficiency</span><b>${eff}</b></div>
      <div><span>Mode</span><b>${escapeHtml(m.mode)}</b></div>
      <div><span>Uptime</span><b>${m.uptimeSec ? durationText(m.uptimeSec) : '–'}</b></div>
    </div>
    ${sparkline(m.history.temp, '#e5604d', 'Chip °C')}
    ${sparkline(m.history.ths, '#f7931a', 'TH/s')}

    <div class="dialog-section">
      <h3>Controls</h3>
      <div class="actions">
        <button type="button" class="btn btn-small" data-cmd="${m.suspended ? 'wake' : 'sleep'}">${m.suspended ? 'Wake' : 'Sleep'}</button>
        <button type="button" class="btn btn-small" data-cmd="reboot">Reboot</button>
        <button type="button" class="btn btn-small" data-cmd="mode" data-value="eco">Eco</button>
        <button type="button" class="btn btn-small" data-cmd="mode" data-value="normal">Normal</button>
        <button type="button" class="btn btn-small" data-cmd="mode" data-value="high">High</button>
        <button type="button" class="btn btn-small" data-cmd="led" data-value="${m.led ? '' : '1'}">LED ${m.led ? 'off' : 'on'}</button>
      </div>
      <div class="actions" style="margin-top:6px;align-items:center">
        <span class="hint">Power limit ${m.powerPct}%</span>
        ${[100, 80, 60, 40].map((pct) => `<button type="button" class="btn btn-small" data-cmd="powerPct" data-value="${pct}">${pct}%</button>`).join('')}
      </div>
      <p id="miner-note" class="hint" style="margin-top:6px">${mdkSource.active && mdkSource.view ? 'Commands go through MDK. These readings come straight from the simulator.' : ''}</p>
    </div>

    <div class="dialog-section">
      <h3>Faults</h3>
      ${m.faults.length
        ? `<ul class="fault-list">${m.faults.map((f) => `<li><div>${escapeHtml(f.label)}</div><button type="button" class="btn btn-small" data-clear-fault="${f.id}">Clear</button></li>`).join('')}</ul>`
        : '<p class="hint">None on this machine.</p>'}
      <div class="actions" style="margin-top:8px">
        <select id="miner-fault" style="flex:1;padding:3px 6px;background:var(--panel-2);border:1px solid var(--line);border-radius:5px">
          ${minerFaults.map((f) => `<option value="${f.id}" ${f.id === selected ? 'selected' : ''}>${escapeHtml(f.label)}</option>`).join('')}
        </select>
        <button type="button" class="btn btn-small" data-inject>Inject</button>
      </div>
    </div>

    <div class="dialog-section">
      <h3>Pools</h3>
      ${m.pools.map((p) => `<div class="row"><div class="mono" style="word-break:break-all">${escapeHtml(p.url.replace(/^stratum\+tcp:\/\//, ''))}${p.active ? '<span class="tag tag-ok">Active</span>' : ''}</div><div class="num">${p.accepted.toLocaleString()} shares</div></div>`).join('')}
    </div>`
  $('miner-dialog').scrollTop = scroll
}

// --- 3D site --------------------------------------------------------------

const VIEW_KEY = 'sitesim.view'
const site3d = { view: null, loading: null }

function savedView () {
  try {
    return localStorage.getItem(VIEW_KEY) === 'site3d' ? 'site3d' : 'dashboard'
  } catch {
    return 'dashboard'
  }
}

// Loads Three.js only when this view first opens, so the dashboard stays light,
// and a graphics failure leaves the rest of the panel working.
function loadSite3D () {
  site3d.loading ||= import('./site3d.js').then(({ createSite3D }) => {
    site3d.view = createSite3D($('site3d'), {
      colorFor: cellColor,
      onSelectMiner: openMiner,
      onSelectContainer: targetContainerWithFault,
      onWalkChange: (walking) => {
        const button = $('btn-walk')
        button.classList.toggle('active', walking)
        button.textContent = walking ? 'Stop walking' : 'Walk the site'
        if (walking) button.blur()
      },
      describeMiner: (m) => `${m.id} · ${modelInfo(m.model)?.brand || m.model} · ${m.s} · ${m.temp.toFixed(0)}°C · ${m.ths.toFixed(0)} TH/s${m.flt.length ? ` · ${m.flt.join(', ')}` : ''}`
    })
    return site3d.view
  })
  return site3d.loading
}

function targetContainerWithFault (id) {
  $('fault-type').value = 'cooling_failure'
  syncFaultForm()
  $('fault-target').value = id
  $('fault-form').scrollIntoView({ block: 'nearest' })
}

async function setView (view) {
  const is3d = view === 'site3d'
  document.querySelector('.layout').classList.toggle('is-3d', is3d)
  document.querySelector('.panel-3d').hidden = !is3d
  for (const button of $('view-select').children) button.classList.toggle('active', button.dataset.view === view)
  try {
    localStorage.setItem(VIEW_KEY, view)
  } catch {
    // Only a convenience: the panel opens on the dashboard next time.
  }
  if (!is3d) {
    site3d.view?.setActive(false)
    drawCharts()
    return
  }
  const errorEl = $('site3d-error')
  errorEl.hidden = true
  try {
    const scene = await loadSite3D()
    if (ui.state) scene.update(view3dState(ui.state))
    // The view may have changed again while this loaded.
    scene.setActive(document.querySelector('.layout').classList.contains('is-3d'))
    renderLegend()
  } catch (err) {
    console.error(err)
    errorEl.textContent = `The 3D view couldn't start on this browser (${err.message}). Everything it shows is also on the Dashboard view.`
    errorEl.hidden = false
  }
}

// --- data source ----------------------------------------------------------

// Where the 3D view gets its data. "Through MDK" reads what the Kernel and Workers
// report via the bridge that mdk/start.js runs. The clock and test controls still
// talk to the simulator, because those don't exist on a real site.
const BRIDGE_PORT = 8090
const BRIDGE = `${location.protocol}//${location.hostname}:${BRIDGE_PORT}`
const mdkSource = { active: false, view: null, error: null, memory: {}, compare: null, helpers: null, timer: null, polling: false, openDetails: false }

function view3dState (state) {
  if (!mdkSource.active || !mdkSource.view || !mdkSource.helpers) return state
  const { mergeView, viewMatchesFleet } = mdkSource.helpers
  if (!viewMatchesFleet(state, mdkSource.view)) return state
  return mergeView(state, mdkSource.view, mdkSource.memory)
}

// --- curtailment app ------------------------------------------------------

const CURTAIL_POLL_MS = 2000
const CURTAIL_OFF_POLL_MS = 10000
const CURTAIL_STATES = { starting: 'Starting', normal: 'Normal', shedding: 'Shedding', holding: 'Holding', returning: 'Returning' }

function renderCurtailment (status) {
  $('curtail-on').hidden = !status
  $('curtail-off').hidden = Boolean(status)
  const label = $('curtail-state')
  label.textContent = status ? CURTAIL_STATES[status.state] : ''
  label.dataset.state = status?.state ?? ''
  if (!status) {
    $('curtail-off').textContent = 'Not running. Start it with: node mdk/start.js --app curtailment'
    return
  }

  const why = [...status.reasons]
  if (status.signalsLost) why.unshift('Signals lost, so holding what’s shed')
  if (status.rampBlock) why.push(`Return paused: ${status.rampBlock}`)
  $('curtail-why').textContent = why.join('. ')
  $('curtail-why').hidden = !why.length

  const kw = (value) => value === null || value === undefined ? '–' : `${value.toFixed(0)} kW`
  const price = (value) => value === null || value === undefined ? '–' : `$${value.toFixed(3)}`
  const rows = [
    ['Site power', kw(status.powerKw)],
    ['Limit in force', status.limitKw === null ? 'None' : kw(status.limitKw)],
    ['Power price', `${price(status.priceUsdKwh)} /kWh`],
    ['Typical break-even', `${price(status.breakevenUsdKwh)} /kWh`],
    ['On eco', status.eco ?? 0],
    ['Asleep', status.asleep ?? 0],
    ['Coming back', status.returning ?? 0],
    ['Answering', `${status.seen ?? 0} of ${status.miners ?? 0}`]
  ]
  if (status.notBack?.length) rows.push(['Didn’t come back', status.notBack.join(', ')])
  if (status.failedCommands) rows.push(['Failed commands', status.failedCommands])
  const stats = $('curtail-stats')
  stats.replaceChildren(...rows.flatMap(([name, value]) => {
    const dt = document.createElement('dt')
    const dd = document.createElement('dd')
    dt.textContent = name
    dd.textContent = value
    return [dt, dd]
  }))

  const cap = $('curtail-cap')
  if (document.activeElement !== cap) cap.value = status.capKw ?? ''
  const log = $('curtail-log')
  log.replaceChildren(...[...status.recent].reverse().map(({ message }) => {
    const li = document.createElement('li')
    li.textContent = message
    return li
  }))
}

async function pollCurtailment () {
  let status = null
  try {
    const res = await fetch(`${BRIDGE}/curtailment`)
    if (res.ok) status = await res.json()
  } catch {
    // MDK isn't running, which is the usual case.
  }
  renderCurtailment(status)
  setTimeout(pollCurtailment, status ? CURTAIL_POLL_MS : CURTAIL_OFF_POLL_MS)
}

async function submitCurtailmentCap (event) {
  event.preventDefault()
  const error = $('curtail-error')
  const text = $('curtail-cap').value.trim()
  try {
    const res = await fetch(`${BRIDGE}/curtailment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capKw: text === '' ? null : Number(text) })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error)
    error.hidden = true
    $('curtail-cap').blur()
    renderCurtailment(data)
  } catch (err) {
    error.textContent = err.message
    error.hidden = false
  }
}

async function pollBridge () {
  if (!mdkSource.active || mdkSource.polling) return
  mdkSource.polling = true
  try {
    const res = await fetch(`${BRIDGE}/view`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error)
    mdkSource.view = data
    mdkSource.error = null
  } catch (err) {
    mdkSource.view = null
    mdkSource.error = err
  } finally {
    mdkSource.polling = false
  }
  renderSource()
  if (ui.state && is3dOpen()) site3d.view?.update(view3dState(ui.state))
}

function renderSource () {
  const el = $('source-status')
  el.hidden = !mdkSource.active
  if (!mdkSource.active) return
  el.classList.remove('warn')

  if (!mdkSource.view) {
    el.classList.add('warn')
    el.textContent = 'MDK isn’t connected, so this is showing the simulator directly. Start it with: node mdk/start.js (needs Node 24 or newer, and node mdk/setup.js once).'
    return
  }
  const { viewMatchesFleet, compareMiners } = mdkSource.helpers
  if (ui.state && !viewMatchesFleet(ui.state, mdkSource.view)) {
    el.classList.add('warn')
    el.textContent = 'The fleet changed, so MDK’s Workers are out of date, and this is showing the simulator directly. Restart mdk/start.js to reconnect them.'
    return
  }
  const age = (Date.now() - mdkSource.view.at) / 1000
  if (age > 5) {
    el.classList.add('warn')
    el.textContent = `MDK’s view is ${age.toFixed(0)} seconds old. Is mdk/start.js still running?`
    return
  }
  const compare = ui.state ? compareMiners(ui.state.miners, mdkSource.view.miners) : null
  if (!compare) return
  const open = el.querySelector('details')?.open
  const summary = `Showing what MDK reports. The slowest device took ${mdkSource.view.slowestMs} ms. It agrees with the simulator on ${compare.agree} of ${compare.total} miners.`
  el.innerHTML = escapeHtml(summary) + (compare.diffs.length
    ? `<details ${open ? 'open' : ''}><summary>${compare.diffs.length} differ</summary><ul>${compare.diffs.slice(0, 50).map((d) => `<li>${escapeHtml(d.id)}: ${escapeHtml(d.why)}</li>`).join('')}</ul></details>`
    : '')
}

async function setSource (source) {
  const toMdk = source === 'mdk'
  for (const button of $('source-select').children) button.classList.toggle('active', button.dataset.source === source)
  mdkSource.active = toMdk
  clearInterval(mdkSource.timer)
  if (toMdk) {
    mdkSource.helpers ||= await import('./mdk-view.mjs')
    mdkSource.memory = {}
    await pollBridge()
    mdkSource.timer = setInterval(pollBridge, 1000)
  } else {
    mdkSource.view = null
  }
  renderSource()
  if (ui.state) site3d.view?.update(view3dState(ui.state))
}

// Through MDK when that's the source, so a miner's controls take the real route.
async function sendMinerCommand (id, action, value) {
  if (!mdkSource.active || !mdkSource.view) return act('/api/miners/command', { ids: [id], action, value })
  try {
    const res = await fetch(`${BRIDGE}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, action, value })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error)
    return data
  } catch (err) {
    ui.events.unshift({ seq: -Date.now(), t: ui.state?.t || 0, level: 'error', source: 'mdk', message: `${id}: ${err.message}` })
    renderEvents()
    const note = $('miner-note')
    if (note) note.textContent = `MDK refused that: ${err.message}`
    return null
  }
}

// --- full screen ----------------------------------------------------------

const is3dOpen = () => document.querySelector('.layout').classList.contains('is-3d')

function toggleFullscreen () {
  const errorEl = $('site3d-error')
  errorEl.hidden = true
  if (document.fullscreenElement) return document.exitFullscreen()
  return $('site3d').requestFullscreen().catch((err) => {
    errorEl.textContent = `This browser wouldn't go full screen (${err.message}).`
    errorEl.hidden = false
  })
}

function renderFullscreenStatus (state) {
  if (!document.fullscreenElement) return
  const { site, clock } = view3dState(state)
  $('status3d-clock').textContent = `Day ${clock.day} ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`
  $('status3d-stats').textContent = `${fmtHash(site.hashThs).join(' ')} · ${site.powerKw.toFixed(0)}${site.limitKw === null ? '' : ` / ${site.limitKw.toFixed(0)}`} kW · ${site.counts.mining}/${state.miners.length} mining · hottest ${site.maxChipC.toFixed(0)}°C`
  $('status3d-alert').textContent = $('alert-banner').textContent.replace('Close breaker', '').trim()
}

// --- fleet editor ---------------------------------------------------------

const fleetEditor = { limits: null }

const intValue = (el) => {
  const value = Number(el.value)
  return el.value !== '' && Number.isInteger(value) && value >= 0 ? value : null
}

function fleetDraft () {
  const counts = {}
  for (const input of $('fleet-brands').querySelectorAll('input')) counts[input.name] = intValue(input)
  return { containers: intValue($('fleet-containers')), minersPerContainer: intValue($('fleet-per')), counts }
}

// Says what's wrong in plain terms, or what the fleet will be once applied.
function syncFleetForm () {
  const { containers, minersPerContainer, counts } = fleetDraft()
  const status = $('fleet-status')
  const { maxMiners, maxContainers } = fleetEditor.limits
  const values = Object.values(counts)
  const assigned = values.reduce((sum, count) => sum + (count || 0), 0)
  const total = (containers || 0) * (minersPerContainer || 0)
  let problem = null
  if (!containers || containers > maxContainers) problem = `Use 1 to ${maxContainers} containers.`
  else if (!minersPerContainer) problem = 'Use at least 1 miner per container.'
  else if (total > maxMiners) problem = `That's ${total.toLocaleString()} miners, and the limit is ${maxMiners.toLocaleString()}.`
  else if (values.includes(null)) problem = 'Each brand needs a whole number of miners.'
  else if (assigned !== total) {
    const gap = total - assigned
    problem = `${assigned.toLocaleString()} of ${total.toLocaleString()} miners assigned: ${gap > 0 ? `add ${gap.toLocaleString()} more` : `remove ${(-gap).toLocaleString()}`}.`
  }

  $('fleet-apply').disabled = Boolean(problem)
  status.classList.toggle('warn-text', Boolean(problem))
  if (problem) {
    status.textContent = problem
  } else {
    let watts = 0
    let ths = 0
    for (const model of ui.catalog.models) {
      watts += counts[model.id] * model.nominalW
      ths += counts[model.id] * model.nominalThs
    }
    status.textContent = `${total.toLocaleString()} miners, about ${fmtHash(ths).join(' ')} and ${(watts / 1000).toFixed(0)} kW at rated output.`
  }

  const mix = ui.catalog.models.filter((m) => counts[m.id] > 0).map((m) => `${m.id}=${counts[m.id]}`).join(',')
  $('fleet-cli').textContent = `node bin/sitesim.js --containers ${containers ?? 0} --miners-per-container ${minersPerContainer ?? 0} --mix ${mix || 'avalon=1'}`
}

async function openFleetEditor () {
  const fleet = await api('/api/fleet')
  fleetEditor.limits = fleet
  $('fleet-containers').value = fleet.containers
  $('fleet-per').value = fleet.minersPerContainer
  $('fleet-brands').innerHTML = ui.catalog.models.map((m) => `
    <label class="fleet-brand">
      <span><i style="background:${m.color}"></i>${escapeHtml(m.brand)}<small>${escapeHtml(m.name)} · ${m.nominalThs} TH/s · ${m.nominalW.toLocaleString()} W</small></span>
      <input name="${m.id}" type="number" min="0" step="1" inputmode="numeric" value="${fleet.counts[m.id]}" aria-label="${escapeHtml(m.brand)} miners">
    </label>`).join('')
  $('fleet-error').hidden = true
  syncFleetForm()
  $('fleet-dialog').showModal()
}

// Spreads the total across the brands in use, or across all if none are.
function splitFleetEvenly () {
  const { containers, minersPerContainer, counts } = fleetDraft()
  const total = (containers || 0) * (minersPerContainer || 0)
  const used = Object.keys(counts).filter((id) => counts[id] > 0)
  const ids = used.length ? used : Object.keys(counts)
  ids.forEach((id, i) => {
    counts[id] = Math.floor(total / ids.length) + (i < total % ids.length ? 1 : 0)
  })
  for (const input of $('fleet-brands').querySelectorAll('input')) {
    input.value = ids.includes(input.name) ? counts[input.name] : 0
  }
  syncFleetForm()
}

async function applyFleetEditor (event) {
  event.preventDefault()
  const button = $('fleet-apply')
  const errorEl = $('fleet-error')
  errorEl.hidden = true
  button.disabled = true
  button.textContent = 'Applying…'
  try {
    await api('/api/fleet', fleetDraft())
    $('fleet-dialog').close()
  } catch (err) {
    errorEl.textContent = friendlyError(err)
    errorEl.hidden = false
  } finally {
    button.textContent = 'Apply and restart simulation'
    syncFleetForm()
  }
}

function openMiner (id) {
  for (const cell of ui.cells.values()) cell.classList.remove('selected')
  ui.cells.get(id)?.classList.add('selected')
  ui.selectedMiner = id
  renderMiner().then(() => {
    const dialog = $('miner-dialog')
    if (!dialog.open) dialog.showModal()
  })
}

// --- wiring ---------------------------------------------------------------

function bindEvents () {
  $('btn-pause').onclick = () => act('/api/control', { action: ui.state?.runtime.paused ? 'resume' : 'pause' })
  $('btn-reset').onclick = async () => {
    await act('/api/control', { action: 'reset' })
    ui.events = []
    ui.history = []
    renderEvents()
    refreshHistory()
  }
  $('speeds').onclick = (e) => {
    const speed = e.target.dataset.speed
    if (speed) act('/api/control', { action: 'speed', value: Number(speed) })
  }
  const chooseMetric = (e) => {
    const { metric } = e.target.dataset
    if (!metric) return
    ui.metric = metric
    for (const group of [$('metric-select'), $('metric-select-3d')]) {
      for (const button of group.children) button.classList.toggle('active', button.dataset.metric === metric)
    }
    renderLegend()
    if (ui.state) {
      renderFleet(ui.state)
      site3d.view?.update(view3dState(ui.state))
    }
  }
  $('metric-select').onclick = chooseMetric
  $('metric-select-3d').onclick = chooseMetric
  $('source-select').onclick = (e) => {
    if (e.target.dataset.source) setSource(e.target.dataset.source)
  }
  $('view-select').onclick = (e) => {
    if (e.target.dataset.view) setView(e.target.dataset.view)
  }
  // Phones without the Fullscreen API simply don't get the button.
  $('btn-fullscreen').hidden = !document.fullscreenEnabled
  $('btn-fullscreen').onclick = (e) => {
    e.currentTarget.blur()
    toggleFullscreen()
  }
  $('btn-fullscreen-exit').onclick = () => document.exitFullscreen()
  document.addEventListener('fullscreenchange', () => {
    $('btn-fullscreen').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen'
    if (document.fullscreenElement && ui.state) renderFullscreenStatus(ui.state)
  })
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyF' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
    if (!is3dOpen() || !document.fullscreenEnabled || document.querySelector('dialog[open]')) return
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return
    e.preventDefault()
    toggleFullscreen()
  })

  $('btn-camera').onclick = () => {
    site3d.view?.stopWalking()
    site3d.view?.resetCamera()
  }
  $('btn-walk').onclick = () => {
    if (!site3d.view) return
    if (site3d.view.walk) site3d.view.stopWalking()
    else site3d.view.startWalking()
  }
  $('window-select').onclick = (e) => {
    const { window: w } = e.target.dataset
    if (w === undefined) return
    ui.windowSec = Number(w)
    for (const button of $('window-select').children) button.classList.toggle('active', button === e.target)
    refreshHistory()
  }
  $('fleet').onclick = (e) => {
    if (e.target.dataset.id) openMiner(e.target.dataset.id)
  }
  document.querySelector('.bulk').onclick = (e) => {
    const { bulk, bulkMode } = e.target.dataset
    if (!bulk && !bulkMode) return
    const ids = ui.state.miners.map((m) => m.id)
    if (bulk) act('/api/miners/command', { ids, action: bulk })
    else act('/api/miners/command', { ids, action: 'mode', value: bulkMode })
  }
  $('scenario-list').onclick = (e) => {
    const button = e.target.closest('[data-scenario]')
    if (button) act('/api/scenarios/start', { id: button.dataset.scenario })
  }
  $('fault-type').onchange = syncFaultForm
  $('fault-form').onsubmit = async (e) => {
    e.preventDefault()
    const errorEl = $('fault-error')
    errorEl.hidden = true
    const params = {}
    for (const input of $('fault-params').querySelectorAll('input')) params[input.name] = Number(input.value)
    try {
      await api('/api/faults', {
        type: $('fault-type').value,
        target: $('fault-target').value,
        params,
        durationSec: Number($('fault-duration').value) || undefined
      })
    } catch (err) {
      errorEl.textContent = friendlyError(err)
      errorEl.hidden = false
    }
  }
  $('fault-list').onclick = (e) => {
    const groupId = e.target.dataset.clearGroup
    if (groupId) act('/api/faults/clear', { groupId: Number(groupId) })
  }
  $('btn-clear-all').onclick = () => act('/api/faults/clear', { all: true })
  $('chaos').onchange = (e) => act('/api/site', { chaos: { enabled: e.target.checked } })

  $('btn-fleet').onclick = () => openFleetEditor().catch((err) => {
    ui.events.unshift({ seq: -Date.now(), t: ui.state?.t || 0, level: 'error', source: 'panel', message: friendlyError(err) })
    renderEvents()
  })
  $('fleet-form').oninput = syncFleetForm
  $('fleet-form').onsubmit = applyFleetEditor
  $('fleet-even').onclick = splitFleetEvenly

  $('curtail-form').addEventListener('submit', submitCurtailmentCap)
  pollCurtailment()

  $('btn-mdk').onclick = async () => {
    const config = await api('/api/mdk/config')
    // Long device lists would bury the rest, so show their shape and a count.
    const trim = (list) => list.length > 2 ? [...list.slice(0, 2), `… and ${list.length - 2} more`] : list
    const shown = Object.fromEntries(Object.entries(config).map(([name, section]) => {
      const out = { ...section }
      for (const key of ['seedDevices', 'devices']) if (out[key]) out[key] = trim(out[key])
      return [name, out]
    }))
    $('mdk-config').textContent = `${JSON.stringify(shown, null, 2)}\n\n// Full list: GET /api/mdk/config, or run: node bin/sitesim.js mdk-config`
    $('mdk-dialog').showModal()
  }

  document.addEventListener('click', (e) => {
    if ('close' in e.target.dataset) e.target.closest('dialog').close()
  })

  const minerDialog = $('miner-dialog')
  minerDialog.addEventListener('close', () => {
    // This event arrives late, and another miner may have been opened by then.
    if (minerDialog.open) return
    ui.cells.get(ui.selectedMiner)?.classList.remove('selected')
    ui.selectedMiner = null
  })
  minerDialog.addEventListener('click', async (e) => {
    if (e.target === minerDialog) {
      minerDialog.close()
      return
    }
    const id = ui.selectedMiner
    const { cmd, value, clearFault } = e.target.dataset
    if (cmd) {
      await sendMinerCommand(id, cmd, cmd === 'led' ? Boolean(value) : value)
    } else if (clearFault) {
      await act('/api/faults/clear', { id: Number(clearFault) })
    } else if ('inject' in e.target.dataset) {
      await act('/api/faults', { type: $('miner-fault').value, target: `miner:${id}` })
    } else {
      return
    }
    renderMiner()
  })

  for (const spec of Object.values(SERIES)) {
    const canvas = $(spec.el)
    canvas.addEventListener('mousemove', (e) => {
      ui.hover.set(spec.el, e.offsetX)
      drawChart(spec)
    })
    canvas.addEventListener('mouseleave', () => {
      ui.hover.delete(spec.el)
      drawChart(spec)
    })
  }

  new ResizeObserver(drawCharts).observe($('chart-hash'))
}

function onState (state) {
  // A new run or fleet replaces the site, and everything built on the old one must go.
  const newRun = ui.state && state.runtime.generation !== ui.state.runtime.generation
  if (newRun) {
    ui.events = []
    ui.history = []
    ui.fleetBuilt = false
    if ($('miner-dialog').open) $('miner-dialog').close()
    renderEvents()
    refreshHistory()
  }
  const first = !ui.state
  ui.state = state

  if (first && ui.catalog) renderCatalog()
  if (newRun && ui.catalog) {
    syncFaultForm()
    renderLegend()
  }
  renderTransport(state)
  renderKpis(state)
  renderBanner(state)
  renderFullscreenStatus(state)
  renderFleet(state)
  if (document.querySelector('.layout').classList.contains('is-3d')) site3d.view?.update(view3dState(state))
  renderModels(state)
  renderScenarios(state)
  renderFaults(state)
  renderPools(state)
  renderContainers(state)
  renderProtocols(state)
  mergeEvents(state)
}

function connect () {
  const conn = $('conn')
  const source = new EventSource('/api/events')
  source.onopen = () => {
    conn.className = 'conn live'
    conn.lastElementChild.textContent = 'Live'
  }
  source.onmessage = (e) => onState(JSON.parse(e.data))
  source.onerror = () => {
    conn.className = 'conn down'
    conn.lastElementChild.textContent = 'Disconnected'
  }
}

async function main () {
  bindEvents()
  renderLegend()
  ui.catalog = await api('/api/catalog')
  renderLegend()
  if (ui.state) renderCatalog()
  connect()
  if (savedView() === 'site3d') setView('site3d')
  refreshHistory()
  setInterval(refreshHistory, 2000)
  setInterval(() => {
    if (ui.selectedMiner) renderMiner()
  }, 2000)
}

main()
