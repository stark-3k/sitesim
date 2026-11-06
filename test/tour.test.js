'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const load = () => import('../public/tour.mjs')
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8')
const screen = { width: 1600, height: 1000 }
const card = { width: 380, height: 220 }

const inside = ({ left, top }, size, view) => left >= 0 && top >= 0 && left + size.width <= view.width && top + size.height <= view.height
const overlaps = (a, size, b) => a.left < b.left + b.width && b.left < a.left + size.width && a.top < b.top + b.height && b.top < a.top + size.height

test('every step points at something on the page', async () => {
  const { STEPS } = await load()
  for (const { target } of STEPS) {
    if (!target) continue
    const name = target.slice(1)
    assert.ok(target[0] === '#' ? html.includes(`id="${name}"`) : new RegExp(`class="[^"]*\\b${name}\\b`).test(html), `${target} isn't in index.html`)
  }
})

test('the scenario it offers exists, and matches how it’s described', async () => {
  const { STEPS, STARTER_SCENARIO } = await load()
  const scenario = JSON.parse(fs.readFileSync(path.join(__dirname, `../scenarios/${STARTER_SCENARIO}.json`), 'utf8'))
  assert.equal(scenario.duration, '02:00:00')
  assert.equal(scenario.speed, 60)
  assert.equal(STEPS.at(-1).action.scenario, STARTER_SCENARIO)
})

test('the commands it gives are real', async () => {
  const { STEPS } = await load()
  const { code } = STEPS.find((s) => s.code)
  for (const file of code.matchAll(/node (\S+)/g)) assert.ok(fs.existsSync(path.join(__dirname, '..', file[1])), file[1])
})

test('with no target, the card sits in the middle', async () => {
  const { placeCard } = await load()
  assert.deepEqual(placeCard(null, card, screen), { left: 610, top: 390 })
})

test('the card stays on screen and clear of its target wherever there’s room', async () => {
  const { placeCard } = await load()
  const targets = [
    { left: 20, top: 70, width: 1560, height: 100 },
    { left: 20, top: 700, width: 500, height: 280 },
    { left: 1280, top: 200, width: 300, height: 600 },
    { left: 20, top: 180, width: 1150, height: 800 }
  ]
  for (const target of targets) {
    const placed = placeCard(target, card, screen)
    assert.ok(inside(placed, card, screen), JSON.stringify(placed))
    assert.ok(!overlaps(placed, card, target), `${JSON.stringify(placed)} covers ${JSON.stringify(target)}`)
  }
})

test('on a phone, a target too big to avoid still leaves the card on screen', async () => {
  const { placeCard } = await load()
  const phone = { width: 390, height: 800 }
  const small = { width: 366, height: 240 }
  const placed = placeCard({ left: 10, top: 20, width: 370, height: 770 }, small, phone)
  assert.ok(inside(placed, small, phone), JSON.stringify(placed))
})

test('the highlight is clipped to the screen', async () => {
  const { highlightRect } = await load()
  const box = highlightRect({ left: 0, top: 900, width: 1700, height: 300 }, screen)
  assert.ok(box.left >= 0 && box.left + box.width <= screen.width)
  assert.ok(box.top + box.height <= screen.height)
})
