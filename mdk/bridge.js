'use strict'

// Passes MDK's view of a site to a browser. It reads only through the MDK client,
// and sends commands only through the Kernel, so it would work the same against
// real devices. A site map says what MDK can't: which miner sits where.

const http = require('http')
const { normalizeMiner, normalizeMeter, normalizeSensor, commandFor } = require('./normalize')

const PUBLISH_MS = 1000
// Workers cache for 2 to 5 seconds, so reading faster gains little. Measured with 120
// miners: every second stalled some Proto and Whatsminer reads past 5 seconds, and
// every 3 seconds none of theirs passed 1 second.
const READ_MS = 3000
const CONCURRENCY = 24
// A device that hasn't answered for this long counts as unreachable, whatever it's
// doing. It allows one slow read, since that alone says nothing about the device.
const STALE_MS = 9000
const PULL_TIMEOUT_MS = 5000
const COMMAND_WAIT_MS = 8000
const COMMAND_POLL_MS = 200
const MAX_BODY = 16 * 1024
const FINISHED = new Set(['SUCCESS', 'FAILED', 'TIMEOUT', 'REJECTED'])

class MdkBridge {
  /**
   * @param {object} opts
   * @param {object} opts.client MDK client
   * @param {object[]} opts.workers from the Kernel: { workerId, deviceIds }
   * @param {object} opts.siteMap { containers, miners, sensors, meter }
   * @param {string[]} opts.allowOrigins pages allowed to read and command
   * @param {string} [opts.host]
   * @param {function} [opts.log]
   */
  constructor (opts) {
    Object.assign(this, { host: '127.0.0.1', log: () => {}, staleMs: STALE_MS, pullTimeoutMs: PULL_TIMEOUT_MS }, opts)
    this.devices = new Map()
    this.minerDevice = new Map()
    this.lastMetrics = new Map()
    // The latest answer from each device: { metrics, at, tookMs, pending }.
    this.readings = new Map()
    this.view = null
  }

  // Connects site map entries to Kernel device IDs. Some Workers use the IDs they
  // were given, and others generate their own and report the serial number.
  async resolveDevices () {
    const byId = new Map(this.siteMap.miners.map((m) => [m.id, m]))
    const bySerial = new Map(this.siteMap.miners.map((m) => [m.serial, m]))
    const sensorBySerial = new Map(this.siteMap.sensors.map((s) => [s.serial, s]))

    for (const worker of this.workers) {
      if (worker.workerId === 'sim-f2pool' || !worker.deviceIds.length) continue
      const serials = await this._serialsOf(worker)
      for (const deviceId of worker.deviceIds) {
        const serial = serials.get(deviceId)
        const miner = byId.get(deviceId) ?? bySerial.get(serial)
        if (miner) {
          this.devices.set(deviceId, { kind: 'miner', entry: miner })
          this.minerDevice.set(miner.id, deviceId)
        } else if (sensorBySerial.has(serial)) {
          this.devices.set(deviceId, { kind: 'sensor', entry: sensorBySerial.get(serial) })
        } else if (serial === this.siteMap.meter?.serial) {
          this.devices.set(deviceId, { kind: 'meter' })
        }
      }
    }
    const missing = this.siteMap.miners.filter((m) => !this.minerDevice.has(m.id)).map((m) => m.id)
    if (missing.length) this.log(`${missing.length} miners on the site map have no MDK device, such as ${missing[0]}`)
  }

  async _serialsOf (worker) {
    const serials = new Map()
    try {
      const listing = await this.client.pullTelemetry(worker.deviceIds[0], 'list')
      for (const thing of listing.things ?? []) serials.set(thing.id, thing.info?.serialNum)
    } catch {
      // Workers without provisioning don't support listing. They use the given IDs.
    }
    return serials
  }

  // Reads one device with a time limit. Each device has at most one read under way,
  // so a stuck one costs a single slot rather than a growing pile.
  async _read (deviceId) {
    const reading = this.readings.get(deviceId) ?? { metrics: null, at: 0, tookMs: 0, pending: false }
    this.readings.set(deviceId, reading)
    if (reading.pending) return
    reading.pending = true
    const started = Date.now()
    let timer
    try {
      const telemetry = await Promise.race([
        this.client.pullTelemetry(deviceId, 'metrics'),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('ERR_BRIDGE_TIMEOUT')), this.pullTimeoutMs)
        })
      ])
      reading.metrics = telemetry.metrics || telemetry
      reading.at = Date.now()
    } catch (err) {
      // A slow read is no news, so the last reading stands until it goes stale. Any
      // other failure is an answer: the device reads as unreachable right away.
      if (err.message !== 'ERR_BRIDGE_TIMEOUT') {
        reading.metrics = null
        reading.at = Date.now()
      }
    } finally {
      clearTimeout(timer)
      reading.tookMs = Date.now() - started
      reading.pending = false
    }
  }

  async _readAll () {
    const ids = [...this.devices.keys()].filter((id) => !this.readings.get(id)?.pending)
    let next = 0
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (next < ids.length) await this._read(ids[next++])
    }))
  }

  // Builds the view from the latest readings, without waiting on anything.
  _buildView (now = Date.now()) {
    const miners = []
    const sensors = {}
    let meter = null
    let slowestMs = 0

    for (const [deviceId, device] of this.devices) {
      const reading = this.readings.get(deviceId)
      const fresh = reading && now - reading.at <= this.staleMs
      const metrics = fresh ? reading.metrics : null
      if (reading) slowestMs = Math.max(slowestMs, reading.tookMs)

      if (device.kind === 'miner') {
        const miner = normalizeMiner(metrics ?? {}, device.entry)
        // Keep the last temperature for an unreachable miner, as nothing newer exists.
        if (!miner.net) miner.temp = this.lastMetrics.get(deviceId)?.temp ?? 0
        else this.lastMetrics.set(deviceId, { temp: miner.temp })
        miner.deviceId = deviceId
        miners.push(miner)
      } else if (device.kind === 'sensor' && metrics) {
        const { container, channel } = device.entry
        sensors[container] ||= {}
        sensors[container][channel] = normalizeSensor(metrics)
      } else if (device.kind === 'meter' && metrics) {
        meter = normalizeMeter(metrics)
      }
    }

    this.view = {
      at: now,
      slowestMs,
      miners: miners.sort((a, b) => a.id.localeCompare(b.id)),
      sensors,
      meter,
      containers: this.siteMap.containers
    }
    return this.view
  }

  // One full pass, used at startup so the first view is complete.
  async poll () {
    await this._readAll()
    return this._buildView()
  }

  startPolling () {
    this.readTimer = setInterval(() => {
      this._readAll().catch((err) => this.log(`Read failed: ${err.message}`))
    }, READ_MS)
    this.timer = setInterval(() => this._buildView(), PUBLISH_MS)
    this.readTimer.unref()
    this.timer.unref()
  }

  // Sends a command and waits for its outcome: the Kernel's first answer only says
  // it was queued, which doesn't mean it worked.
  async command ({ id, action, value }) {
    const entry = this.siteMap.miners.find((m) => m.id === id)
    const deviceId = this.minerDevice.get(id)
    if (!entry || !deviceId) return { status: 404, body: { error: `MDK has no device for ${id}` } }

    let request = commandFor(entry.model, action, value)
    // The panel's power limit is a percentage, and some Workers take watts instead.
    if (!request && action === 'powerPct') request = commandFor(entry.model, 'powerW', Math.round((entry.nw * Number(value)) / 100))
    if (!request) return { status: 400, body: { error: `${entry.brand}'s MDK Worker has no command for ${action}${value === undefined ? '' : ` ${value}`}` } }

    const [command, params] = request
    const sent = await this.client.sendCommand(deviceId, command, params)
    if (sent?.status === 'REJECTED') return { status: 400, body: { error: sent.error, command } }

    const deadline = Date.now() + COMMAND_WAIT_MS
    while (sent?.commandId && Date.now() < deadline) {
      const outcome = await this.client.getCommandStatus(sent.commandId)
      if (FINISHED.has(outcome?.status)) {
        if (outcome.status !== 'SUCCESS') return { status: 400, body: { error: outcome.error || `The command ended as ${outcome.status}`, command } }
        return { status: 200, body: { ok: true, command, status: outcome.status } }
      }
      await new Promise((resolve) => setTimeout(resolve, COMMAND_POLL_MS))
    }
    return { status: 200, body: { ok: true, command, status: 'PENDING' } }
  }

  _allowed (req) {
    const origin = req.headers.origin
    return !origin || this.allowOrigins.includes(origin)
  }

  // Commands reach real machines on a real site, so this only answers its own host
  // and the panel's origin, and any write has to be JSON.
  _onRequest (req, res) {
    const headers = { 'content-type': 'application/json' }
    const origin = req.headers.origin
    if (origin && this.allowOrigins.includes(origin)) {
      headers['access-control-allow-origin'] = origin
      headers.vary = 'origin'
    }
    const send = (status, body) => {
      res.writeHead(status, { ...headers, connection: 'close' })
      res.end(JSON.stringify(body))
    }

    if (!this.allowedHosts.has((req.headers.host || '').toLowerCase()) || !this._allowed(req)) {
      return send(403, { error: 'This address or page isn’t allowed to use the bridge.' })
    }
    if (req.method === 'OPTIONS') {
      headers['access-control-allow-methods'] = 'GET, POST'
      headers['access-control-allow-headers'] = 'content-type'
      return send(204, {})
    }
    if (req.url === '/curtailment' && !this.app) return send(404, { error: 'The curtailment app isn’t running.' })
    if (req.method === 'GET' && req.url === '/curtailment') return send(200, this.app.status())
    if (req.method === 'GET' && req.url === '/view') {
      return this.view ? send(200, this.view) : send(503, { error: 'The first reading is still on its way.' })
    }
    if (req.method === 'POST' && (req.url === '/command' || req.url === '/curtailment')) {
      if ((req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') {
        return send(403, { error: 'Commands have to be JSON.' })
      }
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY) req.destroy()
        else chunks.push(chunk)
      })
      req.on('end', async () => {
        try {
          const request = JSON.parse(Buffer.concat(chunks).toString())
          if (req.url === '/curtailment') {
            this.app.setCap(request.capKw)
            return send(200, this.app.status())
          }
          const { status, body } = await this.command(request)
          return send(status, body)
        } catch (err) {
          return send(err instanceof SyntaxError || req.url === '/curtailment' ? 400 : 500, { error: err.message })
        }
      })
      return undefined
    }
    return send(404, { error: 'Not found' })
  }

  async listen (port) {
    this.server = http.createServer((req, res) => this._onRequest(req, res))
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, this.host, resolve)
    })
    const bound = this.server.address().port
    this.allowedHosts = new Set([`127.0.0.1:${bound}`, `localhost:${bound}`, `${this.host}:${bound}`])
    this.port = bound
    return bound
  }

  async stop () {
    clearInterval(this.timer)
    clearInterval(this.readTimer)
    if (this.server) {
      this.server.closeAllConnections()
      await new Promise((resolve) => this.server.close(resolve))
    }
  }
}

module.exports = { MdkBridge }
