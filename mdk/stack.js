'use strict'

// Boots a real MDK Kernel, a Worker for every device family in the simulator's
// settings, and a client. Everything runs in this process.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { createRequire } = require('module')

// A bug in Node 24's fetch, used by MDK's Workers: on macOS, reusing a socket the far
// end has closed throws from inside a callback, where nothing can catch it. Real devices
// close idle connections too, so one quiet miner shouldn't end the stack. Any other
// uncaught error still stops the process, as it should.
function surviveFetchSocketBug () {
  let warned = false
  process.on('uncaughtException', (err) => {
    if (err?.syscall === 'setTypeOfService' && err.code === 'EINVAL') {
      if (!warned) console.error('Ignoring a known Node fetch socket error when a device drops a connection. Those requests will time out.')
      warned = true
      return
    }
    console.error(err)
    process.exit(1)
  })
}

const SERVICE_ACCOUNT = 'sitesim-stack'
const DISCOVERY_TIMEOUT_MS = 120000

const VENDOR_MODELS = ['antminer', 'whatsminer', 'sealminer', 'luxos', 'proto']

async function startStack ({ mdkDir, workersDir, config }) {
  const mdkRequire = createRequire(path.join(path.resolve(mdkDir), 'package.json'))
  const { getKernel, waitForDiscovery, shutdown } = mdkRequire('@tetherto/mdk-core')
  const { createMdkClient } = mdkRequire('@tetherto/mdk-client')
  const { generateCredential } = mdkRequire('@tetherto/mdk-identity')
  const { callerKeyPair, trustKernel } = mdkRequire('@tetherto/mdk-core/lib/local-discovery')
  const { WorkerRuntimeV2 } = mdkRequire('@tetherto/mdk-worker')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitesim-mdk-'))
  const credential = generateCredential()
  const stoppers = []
  let kernel
  let client
  let pool

  const close = async () => {
    // Stopping aborts any fetch the pool Worker has in flight, and it logs each one.
    if (pool) pool.pool._logErr = () => {}
    if (client) await client.close().catch(() => {})
    for (const stop of stoppers.reverse()) await stop().catch(() => {})
    if (kernel) await shutdown(kernel).catch(() => {})
    fs.rmSync(root, { recursive: true, force: true })
  }

  try {
    kernel = await getKernel({
      root,
      rbac: {
        enforcement: 'deny',
        roles: [{
          name: 'stack',
          rules: [
            { resources: ['devices'], verbs: ['read', 'write'] },
            { resources: ['workers'], verbs: ['list'] }
          ]
        }],
        bindings: [{ role: 'stack', subjects: [{ kind: 'ServiceAccount', name: SERVICE_ACCOUNT }] }]
      },
      serviceAccounts: [{ name: SERVICE_ACCOUNT, publicKey: credential.publicKey }]
    })
    const allowedKeys = [kernel.getClientPublicKey()]

    const register = async (worker, runtime) => {
      stoppers.push(() => worker.stop())
      trustKernel(runtime, kernel)
      await kernel.registerWorker(runtime.getPublicKey())
    }

    // The Workers in MDK's own repo each ship a boot function.
    const inRepo = [
      ['@tetherto/mdk-worker-avalon', 'startAvalonWorker', config.avalon, { workerId: 'sim-avalon', model: 'a1346' }],
      ['@tetherto/mdk-worker-satec', 'startSatecWorker', config.satec, { workerId: 'sim-satec', model: 'pm180' }],
      ['@tetherto/mdk-worker-seneca', 'startSenecaWorker', config.seneca, { workerId: 'sim-seneca' }]
    ]
    for (const [pkg, boot, section, opts] of inRepo) {
      if (!section) continue
      const worker = await mdkRequire(pkg)[boot]({
        ...opts,
        allowedKeys,
        storeDir: path.join(root, opts.workerId),
        conf: section.conf,
        seedDevices: section.seedDevices
      })
      await register(worker, worker.runtime)
    }

    pool = await mdkRequire('@tetherto/mdk-worker-f2pool').startF2poolWorker({
      workerId: 'sim-f2pool',
      rack: 'sim-rack',
      allowedKeys,
      storeDir: path.join(root, 'sim-f2pool'),
      conf: { f2pool: config.f2pool }
    })
    await register(pool, pool.runtime)

    // The vendors' Workers load from their own directories.
    for (const model of VENDOR_MODELS) {
      const section = config[model]
      if (!section) continue
      const dir = path.join(workersDir, path.basename(section.worker))
      if (!fs.existsSync(path.join(dir, 'mdk-contract.json'))) {
        throw new Error(`The ${model} Worker isn't in ${dir}. Run: node mdk/setup.js`)
      }
      const runtime = new WorkerRuntimeV2(dir, {
        workerId: `sim-${model}`,
        storeDir: path.join(root, `sim-${model}`),
        allowedKeys,
        devices: section.devices
      })
      await runtime.start()
      await register({ stop: () => runtime.stop() }, runtime)
    }

    const expected = stoppers.length
    const workers = await waitForDiscovery(kernel, { minWorkers: expected, timeoutMs: DISCOVERY_TIMEOUT_MS })
    const ready = workers.filter((worker) => worker.state === 'READY')
    if (ready.length < expected) {
      const late = workers.filter((worker) => worker.state !== 'READY').map((worker) => `${worker.workerId} (${worker.state})`)
      throw new Error(`Only ${ready.length} of ${expected} Workers are ready. Not ready: ${late.join(', ') || 'none listed'}`)
    }

    const caller = callerKeyPair(path.join(root, 'caller'))
    kernel.allowKey(caller.publicKey)
    client = createMdkClient({
      kernelKey: kernel.getPublicKey(),
      kernelKeyPair: caller,
      kernelCredential: { name: SERVICE_ACCOUNT, privateKey: credential.privateKeyPem }
    })
    await client.connect()

    return { kernel, client, pool: pool.pool, workers: ready, close }
  } catch (err) {
    await close()
    throw err
  }
}

module.exports = { startStack, surviveFetchSocketBug }
