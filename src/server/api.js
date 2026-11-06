'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const { publicCatalog } = require('../engine/faults')
const { publicModels } = require('../engine/models')

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public')
const PUSH_MS = 500
const MAX_BODY = 256 * 1024
const MAX_POINTS = 2000

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
}

class HttpError extends Error {
  constructor (status, message) {
    super(message)
    this.status = status
  }
}

// The control API has no login, so it only accepts requests that were clearly
// sent to this host. That stops a web page from driving it through the browser,
// by DNS rebinding or by posting a form to localhost.
function isTrustedRequest (req, allowedHosts) {
  const host = (req.headers.host || '').toLowerCase()
  if (!allowedHosts.has(host)) return false
  if (req.method === 'GET' || req.method === 'HEAD') return true
  const type = (req.headers['content-type'] || '').split(';')[0].trim()
  return type === 'application/json'
}

function readJson (req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'ERR_BODY_TOO_LARGE'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {})
      } catch {
        reject(new HttpError(400, 'ERR_INVALID_JSON'))
      }
    })
    req.on('error', reject)
  })
}

function csvCell (value) {
  return typeof value === 'number' ? +value.toFixed(6) : value
}

function historyCsv (samples) {
  if (!samples.length) return ''
  const columns = Object.keys(samples[0])
  const rows = samples.map((sample) => columns.map((name) => csvCell(sample[name])).join(','))
  return [columns.join(','), ...rows].join('\n') + '\n'
}

function createApi (runner) {
  const allowedHosts = new Set()
  const clients = new Set()

  const stateFor = (eventsAfter) => ({
    ...runner.sim.snapshot({ eventsAfter }),
    runtime: runner.runtime()
  })

  // Each route returns a JSON-serializable result, or throws.
  const routes = {
    'GET /api/state': () => stateFor(0),
    'GET /api/catalog': () => ({
      faults: publicCatalog(),
      models: publicModels(),
      scenarios: [...runner.scenarios.values()].map(({ id, name, description, goal, speed, durationSec }) => ({
        id, name, description, goal, speed, durationSec
      })),
      containers: runner.sim.containers.map((c) => ({ id: c.id, name: c.name })),
      speeds: runner.runtime().speeds
    }),
    'GET /api/mdk/config': () => runner.mdkConfig(),
    'GET /api/mdk/site-map': () => runner.siteMap(),
    'GET /api/fleet': () => runner.fleetView(),
    'POST /api/fleet': async (req) => runner.applyFleet(await readJson(req)),
    'POST /api/control': async (req) => {
      const body = await readJson(req)
      switch (body.action) {
        case 'pause': runner.paused = true; break
        case 'resume': runner.paused = false; break
        case 'speed': runner.setSpeed(body.value); break
        case 'reset': runner.reset(); break
        case 'step': {
          const count = Math.min(86400, Math.max(1, Math.floor(Number(body.seconds) || 1)))
          for (let i = 0; i < count; i++) runner.sim.step(1)
          break
        }
        default: throw new HttpError(400, 'ERR_ACTION_INVALID')
      }
      return { ok: true }
    },
    'POST /api/faults': async (req) => {
      const faults = runner.sim.injectFault(await readJson(req))
      return { faults }
    },
    'POST /api/faults/clear': async (req) => {
      const { id, groupId, all } = await readJson(req)
      if (!all && id === undefined && groupId === undefined) throw new HttpError(400, 'ERR_CLEAR_TARGET_REQUIRED')
      const removed = runner.sim.clearFaults((fault) => all || fault.id === id || fault.groupId === groupId)
      return { removed }
    },
    'POST /api/miners/command': async (req) => {
      const { ids, action, value } = await readJson(req)
      if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'ERR_IDS_REQUIRED')
      for (const id of ids) runner.sim.minerCommand(id, action, value)
      return { ok: true, count: ids.length }
    },
    'POST /api/site': async (req) => {
      const body = await readJson(req)
      runner.sim.setSite(body)
      if (body.resetBreaker) runner.sim.resetBreaker()
      return { ok: true }
    },
    'POST /api/scenarios/start': async (req) => {
      const { id } = await readJson(req)
      runner.startScenario(id)
      return { ok: true }
    },
    'POST /api/scenarios/stop': async (req) => {
      await readJson(req)
      return { result: runner.sim.stopScenario() }
    }
  }

  function serveStatic (pathname, res) {
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
    const file = path.resolve(PUBLIC_DIR, relative)
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'ERR_NOT_FOUND')
    const type = MIME[path.extname(file)]
    if (!type || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'ERR_NOT_FOUND')
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
    fs.createReadStream(file).pipe(res)
  }

  function openStream (res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const client = { res, lastEvent: 0, generation: runner.generation }
    clients.add(client)
    res.on('close', () => clients.delete(client))
  }

  const pushTimer = setInterval(() => {
    if (!clients.size) return
    for (const client of clients) {
      // A new run restarts the event numbering, so the client must start over.
      if (client.generation !== runner.generation) {
        client.generation = runner.generation
        client.lastEvent = 0
      }
      const state = stateFor(client.lastEvent)
      client.lastEvent = runner.sim.eventSeq
      client.res.write(`data: ${JSON.stringify(state)}\n\n`)
    }
  }, PUSH_MS)
  pushTimer.unref()

  const server = http.createServer(async (req, res) => {
    const sendJson = (status, payload) => {
      if (res.headersSent) return
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }

    try {
      if (!isTrustedRequest(req, allowedHosts)) throw new HttpError(403, 'ERR_REQUEST_NOT_TRUSTED')

      const url = new URL(req.url, 'http://localhost')
      const { pathname } = url

      if (req.method === 'GET' && pathname === '/api/events') return openStream(res)

      if (req.method === 'GET' && pathname === '/api/history') {
        const windowSec = Number(url.searchParams.get('window')) || 0
        const points = Math.min(MAX_POINTS, Number(url.searchParams.get('points')) || 480)
        return sendJson(200, { t: runner.sim.t, samples: runner.sim.historyWindow(windowSec, points) })
      }

      if (req.method === 'GET' && pathname === '/api/export.csv') {
        res.writeHead(200, {
          'content-type': 'text/csv',
          'content-disposition': 'attachment; filename="sitesim-history.csv"'
        })
        return res.end(historyCsv(runner.sim.history))
      }

      const minerMatch = pathname.match(/^\/api\/miners\/([\w-]+)$/)
      if (req.method === 'GET' && minerMatch) return sendJson(200, runner.sim.minerDetail(minerMatch[1]))

      const route = routes[`${req.method} ${pathname}`]
      if (route) return sendJson(200, await route(req))

      if (req.method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(pathname, res)
      throw new HttpError(404, 'ERR_NOT_FOUND')
    } catch (err) {
      // Engine validation errors carry an ERR_ code and are the caller's to fix.
      const status = err.status || (String(err.message).startsWith('ERR_') ? 400 : 500)
      if (status === 500) console.error(err)
      return sendJson(status, { error: err.message })
    }
  })

  return {
    server,
    listen (port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          const bound = server.address().port
          for (const name of ['localhost', '127.0.0.1', '[::1]', host]) allowedHosts.add(`${name}:${bound}`.toLowerCase())
          resolve(bound)
        })
      })
    },
    async close () {
      clearInterval(pushTimer)
      for (const client of clients) client.res.end()
      await new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      })
    }
  }
}

module.exports = { createApi, historyCsv, isTrustedRequest }
