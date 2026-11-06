#!/usr/bin/env node
'use strict'

// Fetches MDK and its vendor-maintained miner Workers for mdk/start.js, each
// pinned to the commit MDK's own catalogue lists. Install scripts stay off.
//
//   node mdk/setup.js [--dir <path>]     (default: .mdk in this project)

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { parseArgs } = require('util')

const MDK_REPO = 'https://github.com/tetherto/mdk.git'
const MDK_TAG = 'v0.13.1'
const MDK_NODE_MAJOR = 24

function run (command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] })
}

function npmInstall (dir, extra = []) {
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...extra], dir)
}

function fetchPinned (repoUrl, ref, dir) {
  fs.mkdirSync(dir, { recursive: true })
  run('git', ['init', '-q'], dir)
  run('git', ['remote', 'add', 'origin', repoUrl], dir)
  run('git', ['fetch', '-q', '--depth', '1', 'origin', ref], dir)
  run('git', ['checkout', '-q', 'FETCH_HEAD'], dir)
}

function main () {
  const { values } = parseArgs({ options: { dir: { type: 'string' } } })
  const root = path.resolve(values.dir || path.join(__dirname, '..', '.mdk'))
  const major = Number(process.versions.node.split('.')[0])
  if (major < MDK_NODE_MAJOR) {
    console.error(`MDK needs Node ${MDK_NODE_MAJOR} or newer, and this is ${process.version}.`)
    process.exit(2)
  }

  const mdkDir = path.join(root, 'mdk')
  const workersDir = path.join(root, 'workers')
  fs.mkdirSync(workersDir, { recursive: true })

  if (fs.existsSync(path.join(mdkDir, 'node_modules'))) {
    console.log(`MDK is already in ${mdkDir}`)
  } else {
    console.log(`Fetching MDK ${MDK_TAG}…`)
    if (!fs.existsSync(mdkDir)) {
      run('git', ['clone', '-q', '--depth', '1', '--branch', MDK_TAG, MDK_REPO, mdkDir])
    }
    console.log('Installing MDK dependencies (install scripts are off)…')
    npmInstall(mdkDir)
  }

  const catalogue = JSON.parse(fs.readFileSync(path.join(mdkDir, 'backend/workers/external-workers.json'), 'utf8'))
  for (const entry of catalogue.filter((worker) => worker.family === 'miner')) {
    const dir = path.join(workersDir, path.basename(entry.repoUrl))
    if (fs.existsSync(path.join(dir, '.git'))) {
      console.log(`${entry.brand} Worker is already in ${dir}`)
      continue
    }
    console.log(`Fetching the ${entry.brand} Worker at ${entry.ref.slice(0, 10)}…`)
    fetchPinned(entry.repoUrl, entry.ref, dir)
    npmInstall(dir, ['--omit=dev'])
  }

  console.log(`\nDone. Start everything with:\n\n  node mdk/start.js${values.dir ? ` --dir ${values.dir}` : ''}\n`)
}

try {
  main()
} catch (err) {
  console.error(`Setup failed: ${err.message}`)
  process.exit(1)
}
