'use strict'

const fs = require('fs')
const path = require('path')
const { CATALOG } = require('./faults')

const ACTIONS = new Set(['fault', 'clear', 'command', 'set', 'resetBreaker', 'note'])

function parseTime (value) {
  if (typeof value === 'number') return value
  const parts = String(value).split(':').map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`ERR_SCENARIO_TIME_INVALID: ${value}`)
  }
  return parts[0] * 3600 + parts[1] * 60 + parts[2]
}

function normalize (def) {
  if (!def.id || !def.name || !Array.isArray(def.events)) throw new Error('ERR_SCENARIO_INVALID')
  const events = def.events.map((event) => {
    if (!ACTIONS.has(event.action)) throw new Error(`ERR_SCENARIO_ACTION_INVALID: ${event.action}`)
    if (event.action === 'fault' && !CATALOG[event.type]) throw new Error(`ERR_FAULT_TYPE_INVALID: ${event.type}`)
    return { ...event, at: parseTime(event.at) }
  }).sort((a, b) => a.at - b.at)
  const last = events.length ? events[events.length - 1].at : 0
  return {
    id: def.id,
    name: def.name,
    description: def.description || '',
    speed: def.speed || 60,
    goal: def.goal || '',
    durationSec: def.duration ? parseTime(def.duration) : last + 3600,
    events
  }
}

function loadScenarios (dir) {
  const scenarios = new Map()
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const scenario = normalize(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')))
    scenarios.set(scenario.id, scenario)
  }
  return scenarios
}

module.exports = { loadScenarios, normalize, parseTime }
