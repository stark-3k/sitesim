'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildConfig } = require('../src/config')
const { Runner } = require('../src/runner')
const { createApi, historyCsv } = require('../src/server/api')

let runner
let api
let base
let port

before(async () => {
  runner = new Runner(buildConfig({ seed: 9, fleet: { containers: 2, minersPerContainer: 3 } }))
  api = createApi(runner)
  port = await api.listen(0, '127.0.0.1')
  base = `http://127.0.0.1:${port}`
})

after(async () => {
  await runner.stop()
  await api.close()
})

async function post (route, body = {}) {
  const res = await fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: res.status, body: await res.json() }
}

const get = async (route) => (await fetch(base + route)).json()

test('state describes the whole site', async () => {
  const state = await get('/api/state')
  assert.equal(state.miners.length, 6)
  assert.equal(state.containers.length, 2)
  assert.ok(state.pools.length >= 2)
  assert.equal(typeof state.runtime.speed, 'number')
  assert.ok(state.site.contractKw > 0)
})

test('the catalog lists faults and scenarios', async () => {
  const catalog = await get('/api/catalog')
  assert.ok(catalog.faults.some((f) => f.id === 'fan_failure' && f.params.length))
  assert.ok(catalog.scenarios.some((s) => s.id === 'heatwave' && s.durationSec > 0))
  assert.equal(catalog.faults.some((f) => 'apply' in f), false, 'internal functions stay private')
})

test('faults can be injected and cleared', async () => {
  const { status, body } = await post('/api/faults', { type: 'psu_failure', target: 'random:2' })
  assert.equal(status, 200)
  assert.equal(body.faults.length, 2)
  assert.equal((await get('/api/state')).faults.length, 2)
  const cleared = await post('/api/faults/clear', { groupId: body.faults[0].groupId })
  assert.equal(cleared.body.removed, 2)
})

test('clearing with no target is refused rather than clearing everything', async () => {
  await post('/api/faults', { type: 'heatwave' })
  const { status } = await post('/api/faults/clear', {})
  assert.equal(status, 400)
  assert.equal((await get('/api/state')).faults.length, 1)
  await post('/api/faults/clear', { all: true })
})

test('bad input gets a 400 with the reason', async () => {
  const unknown = await post('/api/faults', { type: 'nope' })
  assert.equal(unknown.status, 400)
  assert.match(unknown.body.error, /ERR_FAULT_TYPE_INVALID/)
  assert.equal((await post('/api/control', { action: 'explode' })).status, 400)
  assert.equal((await post('/api/control', { action: 'speed', value: 7 })).status, 400)
  assert.equal((await post('/api/scenarios/start', { id: 'nope' })).status, 400)
  assert.equal((await post('/api/miners/command', { ids: [] })).status, 400)
  assert.equal((await post('/api/miners/command', { ids: ['nope'], action: 'sleep' })).status, 400)
  assert.equal((await post('/api/site', { contractKw: 'lots' })).status, 400)

  const malformed = await fetch(`${base}/api/faults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json'
  })
  assert.equal(malformed.status, 400)
})

test('transport controls work', async () => {
  await post('/api/control', { action: 'pause' })
  assert.equal((await get('/api/state')).runtime.paused, true)
  await post('/api/control', { action: 'resume' })
  await post('/api/control', { action: 'speed', value: 60 })
  assert.equal((await get('/api/state')).runtime.speed, 60)
  await post('/api/control', { action: 'speed', value: 1 })

  const before = (await get('/api/state')).t
  await post('/api/control', { action: 'step', seconds: 120 })
  assert.equal((await get('/api/state')).t, before + 120)
})

test('miner commands and detail work', async () => {
  const id = runner.sim.miners[0].id
  await post('/api/miners/command', { ids: [id], action: 'sleep' })
  await post('/api/control', { action: 'step', seconds: 5 })
  const detail = await get(`/api/miners/${id}`)
  assert.equal(detail.s, 'sleeping')
  assert.equal(detail.pools.length, 3)
  assert.ok(detail.port > 0)
  await post('/api/miners/command', { ids: [id], action: 'wake' })
  assert.equal((await fetch(`${base}/api/miners/nope`)).status, 400)
})

test('scenarios start through the API and stop with a result', async () => {
  await post('/api/scenarios/start', { id: 'curtailment' })
  const state = await get('/api/state')
  assert.equal(state.scenario.id, 'curtailment')
  assert.equal(state.runtime.speed, 60, 'adopts the scenario speed')
  const stopped = await post('/api/scenarios/stop', {})
  assert.equal(stopped.body.result.id, 'curtailment')
  assert.equal((await get('/api/state')).scenario, null)
  await post('/api/control', { action: 'speed', value: 1 })
})

test('history and the CSV export return samples', async () => {
  await post('/api/control', { action: 'step', seconds: 1800 })
  const { samples } = await get('/api/history?window=600&points=20')
  assert.ok(samples.length > 0 && samples.length <= 25)

  const res = await fetch(`${base}/api/export.csv`)
  assert.match(res.headers.get('content-type'), /text\/csv/)
  const lines = (await res.text()).trim().split('\n')
  assert.ok(lines.length > 10)
  assert.equal(lines[0].split(',')[0], 't')
  assert.equal(lines[1].split(',').length, lines[0].split(',').length)
  assert.equal(historyCsv([]), '')
})

test('the event stream pushes state, sending each event once', async () => {
  const controller = new AbortController()
  const res = await fetch(`${base}/api/events`, { signal: controller.signal })
  assert.match(res.headers.get('content-type'), /text\/event-stream/)

  runner.sim.log('info', 'test', 'marker-event')
  const decoder = new TextDecoder()
  const frames = []
  let text = ''
  for await (const chunk of res.body) {
    text += decoder.decode(chunk)
    const parts = text.split('\n\n')
    text = parts.pop()
    frames.push(...parts.map((part) => JSON.parse(part.replace(/^data: /, ''))))
    if (frames.length >= 2) break
  }
  controller.abort()

  const seen = frames.flatMap((frame) => frame.events).filter((e) => e.message === 'marker-event')
  assert.equal(seen.length, 1)
  assert.ok(frames[0].miners.length === 6)
})

test('the control panel is served, and traversal is not', async () => {
  const page = await fetch(base)
  assert.match(page.headers.get('content-type'), /text\/html/)
  assert.match(await page.text(), /<title>SiteSim<\/title>/)
  assert.equal((await fetch(`${base}/app.js`)).status, 200)
  assert.equal((await fetch(`${base}/style.css`)).status, 200)
  assert.equal((await fetch(`${base}/nope.js`)).status, 404)

  // fetch() normalizes paths, so this goes over a raw socket request.
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/..%2f..%2fpackage.json', headers: { host: `127.0.0.1:${port}` } }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(status, 404)
})

function rawRequest (opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...opts }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('requests from other sites cannot drive the simulator', async () => {
  // A cross-site form post can only send simple content types.
  const form = await rawRequest({
    method: 'POST',
    path: '/api/control',
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'text/plain' }
  }, '{"action":"reset"}')
  assert.equal(form, 403)

  // DNS rebinding arrives with an attacker's hostname.
  const rebound = await rawRequest({
    method: 'POST',
    path: '/api/control',
    headers: { host: 'evil.example:8080', 'content-type': 'application/json' }
  }, '{"action":"reset"}')
  assert.equal(rebound, 403)
  assert.equal(await rawRequest({ method: 'GET', path: '/api/state', headers: { host: 'evil.example' } }), 403)
})

test('the fleet can be read, and bad changes leave it untouched', async () => {
  const before = await get('/api/fleet')
  assert.equal(before.containers, 2)
  assert.equal(Object.values(before.counts).reduce((a, b) => a + b, 0), 6)
  assert.ok(before.maxMiners >= 6)

  const generation = (await get('/api/state')).runtime.generation
  const bad = [
    { containers: 0, minersPerContainer: 3, counts: { avalon: 0 } },
    { containers: 1.5, minersPerContainer: 3, counts: { avalon: 3 } },
    { containers: 99, minersPerContainer: 1, counts: { avalon: 99 } },
    { containers: 1, minersPerContainer: 0, counts: {} },
    { containers: 1, minersPerContainer: 3 },
    { containers: 1, minersPerContainer: 3, counts: [3] },
    { containers: 1, minersPerContainer: 3, counts: { avalon: 2 } },
    { containers: 1, minersPerContainer: 3, counts: { avalon: 4 } },
    { containers: 1, minersPerContainer: 3, counts: { nope: 3 } },
    { containers: 1, minersPerContainer: 3, counts: { avalon: -1, proto: 4 } },
    { containers: 1, minersPerContainer: 3, counts: { avalon: 1.5, proto: 1.5 } },
    { containers: 1, minersPerContainer: 5000, counts: { avalon: 5000 } }
  ]
  for (const body of bad) {
    const { status, body: reply } = await post('/api/fleet', body)
    assert.equal(status, 400, JSON.stringify(body))
    assert.match(reply.error, /^ERR_/)
  }
  assert.deepEqual(await get('/api/fleet'), before)
  assert.equal((await get('/api/state')).runtime.generation, generation)
})

test('applying a fleet replaces the site with exact counts', async () => {
  const start = (await get('/api/state')).runtime.generation
  const { status, body } = await post('/api/fleet', { containers: 3, minersPerContainer: 2, counts: { sealminer: 4, proto: 2 } })
  assert.equal(status, 200)
  assert.equal(body.counts.sealminer, 4)
  assert.equal(body.counts.avalon, 0)

  const state = await get('/api/state')
  assert.equal(state.runtime.generation, start + 1)
  assert.equal(state.t < 5, true, 'the simulation started over')
  assert.equal(state.containers.length, 3)
  assert.equal(state.miners.filter((m) => m.model === 'sealminer').length, 4)
  assert.equal(state.miners.filter((m) => m.model === 'proto').length, 2)
  assert.equal(state.faults.length, 0)
  assert.equal((await get('/api/mdk/config')).sealminer.devices.length, 4)

  // The seed and other settings carry over, and the limits follow the fleet.
  assert.equal(runner.cfg.seed, 9)
  assert.ok(state.site.contractKw > 0 && state.site.contractKw < 40)

  await post('/api/fleet', { containers: 2, minersPerContainer: 3, counts: { avalon: 1, antminer: 1, whatsminer: 1, sealminer: 1, luxos: 1, proto: 1 } })
})

test('a fleet change keeps the event stream working, and restarts its events', async () => {
  const controller = new AbortController()
  const res = await fetch(`${base}/api/events`, { signal: controller.signal })
  const decoder = new TextDecoder()
  let text = ''
  let applied = false
  const frames = []
  for await (const chunk of res.body) {
    text += decoder.decode(chunk)
    const parts = text.split('\n\n')
    text = parts.pop()
    frames.push(...parts.map((part) => JSON.parse(part.replace(/^data: /, ''))))
    if (!applied && frames.length) {
      applied = true
      await post('/api/fleet', { containers: 1, minersPerContainer: 4, counts: { luxos: 4 } })
    }
    if (frames.at(-1)?.miners.length === 4) break
  }
  controller.abort()
  const last = frames.at(-1)
  assert.equal(last.miners.length, 4)
  assert.ok(last.events.some((e) => e.message.startsWith('Site online')), 'the new run’s first event is sent')
  await post('/api/fleet', { containers: 2, minersPerContainer: 3, counts: { avalon: 1, antminer: 1, whatsminer: 1, sealminer: 1, luxos: 1, proto: 1 } })
})

test('oversized bodies are refused', async () => {
  const body = JSON.stringify({ pad: 'x'.repeat(300 * 1024) })
  await assert.rejects(async () => {
    const res = await fetch(`${base}/api/faults`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    if (res.status !== 413) throw new Error('socket closed')
    throw new Error('413')
  })
})

test('the CLI runs headless and writes its output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitesim-test-'))
  const out = path.join(dir, 'run.csv')
  try {
    const stdout = execFileSync(process.execPath, [
      path.join(__dirname, '..', 'bin', 'sitesim.js'),
      '--headless', '--scenario', 'pool-outage', '--containers', '1', '--miners-per-container', '5', '--out', out
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const result = JSON.parse(stdout)
    assert.equal(result.miners, 5)
    assert.equal(result.scenario.reason, 'finished')
    assert.ok(result.energyKwh > 0)
    assert.ok(fs.readFileSync(out, 'utf8').startsWith('t,hash,'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the CLI reports bad arguments plainly', () => {
  const run = (...args) => {
    try {
      execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sitesim.js'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return null
    } catch (err) {
      return err.stderr
    }
  }
  assert.match(run('--headless', '--scenario', 'nope'), /Unknown scenario/)
  assert.match(run('--headless', '--seed', 'abc'), /--seed must be a number/)
  assert.match(run('whatever'), /Unknown command/)
})

test('the mdk-config command prints usable JSON', () => {
  const stdout = execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sitesim.js'), 'mdk-config'], { encoding: 'utf8' })
  const config = JSON.parse(stdout)
  assert.equal(config.avalon.seedDevices.length, 20)
  assert.equal(config.avalon.model, 'a1346')
  for (const model of ['antminer', 'whatsminer', 'sealminer', 'luxos', 'proto']) {
    assert.equal(config[model].devices.length, 20, model)
    assert.ok(config[model].worker.startsWith('https://github.com/'), model)
  }
})
