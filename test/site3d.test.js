'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const load = () => import('../public/site3d-layout.mjs')

test('every miner fits inside its container, and none overlap', async () => {
  const { layoutContainer } = await load()
  for (const count of [1, 2, 3, 7, 25, 60, 61, 200, 990]) {
    const box = layoutContainer(count)
    assert.equal(box.positions.length, count)
    const seen = new Set()
    for (const p of box.positions) {
      assert.ok(Math.abs(p.x) < box.length / 2, `x in ${count}`)
      assert.ok(Math.abs(p.z) < box.width / 2, `z in ${count}`)
      assert.ok(p.y > 0 && p.y < box.height, `y in ${count}`)
      const key = `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`
      assert.ok(!seen.has(key), `overlap at ${key} in ${count}`)
      seen.add(key)
    }
  }
})

test('racks stay inside their container', async () => {
  const { layoutContainer } = await load()
  for (const count of [1, 7, 60, 200, 990]) {
    const box = layoutContainer(count)
    assert.ok(box.racks.length >= 2)
    for (const part of box.racks) {
      assert.ok(Math.abs(part.x) + part.w / 2 <= box.length / 2 + 1e-9, `x in ${count}`)
      assert.ok(Math.abs(part.z) + part.d / 2 <= box.width / 2 + 1e-9, `z in ${count}`)
      assert.ok(part.y + part.h / 2 <= box.height + 1e-9 && part.y - part.h / 2 >= 0, `y in ${count}`)
    }
  }
})

test('every miner has a shelf under it', async () => {
  const { layoutContainer } = await load()
  const { SLOT } = await import('../public/site3d-models.mjs')
  for (const count of [3, 60, 112, 300]) {
    const box = layoutContainer(count)
    const shelves = box.racks.filter((part) => part.w > 0.1)
    for (const p of box.positions) {
      const under = shelves.some((s) => Math.abs(s.z - p.z) < 0.01 && Math.abs((s.y + s.h / 2) - (p.y - SLOT.h / 2)) < 1e-6)
      assert.ok(under, `a miner at ${p.y} is floating with ${count} miners`)
    }
  }
})

test('containers are real sizes until they run out of room', async () => {
  const { layoutContainer } = await load()
  assert.equal(layoutContainer(60).length, 6.06, '20 ft')
  assert.equal(layoutContainer(100).length, 6.06, '20 ft')
  assert.equal(layoutContainer(200).length, 12.19, '40 ft')
  assert.ok(layoutContainer(990).length > 12.19, 'stretched past 40 ft')
  for (const count of [1, 60, 200, 990]) {
    const box = layoutContainer(count)
    assert.equal(box.width, 2.44)
    assert.equal(box.height, 2.59)
  }
})

test('a part-full container spreads its miners along its length', async () => {
  const { layoutContainer } = await load()
  assert.equal(layoutContainer(60).shelves, 2, 'fits low and long')
  assert.equal(layoutContainer(112).shelves, 4, 'a full 20 ft needs all four')
  assert.equal(layoutContainer(990).shelves, 4)
  for (const count of [1, 2, 30, 60, 90, 112, 113, 200, 296, 300, 990]) {
    const box = layoutContainer(count)
    assert.ok(box.shelves >= 2 && box.shelves <= 4, `${count}`)
    assert.ok(box.shelves * box.columns * 2 >= count, `room for ${count}`)
    assert.ok(box.columns * 0.27 <= box.length, `${count} fits its length`)
  }
})

test('power runs never cross a container, and every container gets one', async () => {
  const { layoutSite } = await load()
  for (const n of [1, 2, 3, 4, 5, 9, 10, 25, 50]) {
    const { boxes, yard } = layoutSite(Array.from({ length: n }, (_, i) => ({ id: `c${i}`, minerCount: 60 })))
    assert.deepEqual(yard.runs.map((r) => r.id), boxes.map((b) => b.id))
    for (const run of yard.runs) {
      for (const seg of run.segments) {
        for (const box of boxes) {
          const overlapX = Math.abs(seg.x - box.origin.x) < (seg.w + box.length) / 2 - 0.2
          const overlapZ = Math.abs(seg.z - box.origin.z) < (seg.d + box.width) / 2 - 0.01
          assert.ok(!(overlapX && overlapZ), `${run.id}'s power run crosses ${box.id} with ${n} containers`)
        }
      }
    }
  }
})

test('everything sits inside the fence, and the gate faces the road', async () => {
  const { layoutSite } = await load()
  for (const n of [1, 2, 9, 50]) {
    const { boxes, yard } = layoutSite(Array.from({ length: n }, (_, i) => ({ id: `c${i}`, minerCount: 100 })))
    const { fence, substation, masts, road } = yard
    const inside = (x, z) => x > fence.minX && x < fence.maxX && z > fence.minZ && z < fence.maxZ
    for (const box of boxes) {
      assert.ok(inside(box.origin.x - box.length / 2, box.origin.z - box.width / 2) && inside(box.origin.x + box.length / 2, box.origin.z + box.width / 2))
    }
    assert.ok(inside(substation.x, substation.z))
    assert.ok(masts.every((m) => inside(m.x, m.z)))
    assert.ok(road.width <= fence.gateHalf * 2, 'the road fits through the gate')
    assert.ok(Math.abs(road.x) < fence.gateHalf)
  }
})

test('containers in the yard never overlap', async () => {
  const { layoutSite } = await load()
  for (const n of [1, 2, 3, 4, 5, 10, 50]) {
    const { boxes, radius } = layoutSite(Array.from({ length: n }, (_, i) => ({ id: `c${i}`, minerCount: 60 })))
    assert.equal(boxes.length, n)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = boxes[i]
        const b = boxes[j]
        const apart = Math.abs(a.origin.x - b.origin.x) > (a.length + b.length) / 2 ||
          Math.abs(a.origin.z - b.origin.z) > (a.width + b.width) / 2
        assert.ok(apart, `${a.id} and ${b.id} overlap with ${n} containers`)
      }
    }
    assert.ok(radius > 0)
  }
})

test('uneven containers still fit the yard', async () => {
  const { layoutSite } = await load()
  const { boxes } = layoutSite([{ id: 'a', minerCount: 500 }, { id: 'b', minerCount: 2 }])
  assert.ok(Math.abs(boxes[0].origin.x - boxes[1].origin.x) > (boxes[0].length + boxes[1].length) / 2)
})

test('the camera backs away for narrower panels and bigger sites', async () => {
  const { layoutSite, cameraDistance } = await load()
  const two = layoutSite([{ id: 'a', minerCount: 60 }, { id: 'b', minerCount: 60 }])
  const many = layoutSite(Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, minerCount: 100 })))
  const wide = cameraDistance(two, 42, 2, 0.6)
  assert.ok(cameraDistance(two, 42, 0.5, 0.6) > wide * 1.5, 'a phone needs more distance')
  assert.ok(cameraDistance(many, 42, 2, 0.6) > wide * 1.2, 'a big yard needs more distance')
  assert.ok(Number.isFinite(cameraDistance(layoutSite([{ id: 'a', minerCount: 1 }]), 42, 1, 0.6)))
})

test('the site’s extent covers every container', async () => {
  const { layoutSite } = await load()
  const site = layoutSite(Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, minerCount: 40 })))
  for (const box of site.boxes) {
    assert.ok(Math.abs(box.origin.x) + box.length / 2 <= site.halfX + 1e-9)
    assert.ok(Math.abs(box.origin.z) + box.width / 2 <= site.halfZ + 1e-9)
  }
})

test('the signature changes when the layout would, and only then', async () => {
  const { fleetSignature } = await load()
  const state = (miners, containers = [{ id: 'c1' }]) => ({ containers, miners })
  const a = [{ c: 'c1', id: 'm1', model: 'avalon', temp: 60 }]
  assert.equal(fleetSignature(state(a)), fleetSignature(state([{ ...a[0], temp: 90 }])), 'live values don’t rebuild')
  assert.notEqual(fleetSignature(state(a)), fleetSignature(state([{ ...a[0], model: 'proto' }])))
  assert.notEqual(fleetSignature(state(a)), fleetSignature(state(a, [{ id: 'c1' }, { id: 'c2' }])))
})

test('every miner model in the engine has a look, and fits its rack slot', async () => {
  const { MINER_MODELS, SLOT, LED_H, partsFor } = await import('../public/site3d-models.mjs')
  const { MODELS } = require('../src/engine/models')
  for (const id of Object.keys(MODELS)) {
    const model = MINER_MODELS[id]
    assert.ok(model, `${id} has no 3D model`)
    assert.ok(model.w <= SLOT.w && model.d <= SLOT.d, id)
    assert.ok(model.h + LED_H + model.psuH <= SLOT.h, `${id} is too tall for its slot`)
    const parts = partsFor(model)
    assert.equal(parts.fans.length, model.fans * 2, 'fans on both ends')
    assert.equal(parts.fans.filter((f) => f.side === 1).length, model.fans)
    assert.equal(Boolean(parts.psu), model.psuH > 0)
    assert.ok(parts.fanSize <= model.w && parts.fanSize * model.fans <= model.h, `${id}'s fans overflow the chassis`)
    for (const fan of parts.fans) {
      assert.ok(Math.abs(fan.y) + parts.fanSize / 2 <= SLOT.h / 2 + 1e-9, `${id}'s fan leaves the slot`)
    }
    const top = (parts.psu ? parts.psu.y + parts.psu.h / 2 : parts.led.y + parts.led.h / 2)
    assert.ok(top <= SLOT.h / 2 + 1e-9, id)
  }
})

test('an unknown model still gets drawn', async () => {
  const { modelFor, FALLBACK_MODEL } = await import('../public/site3d-models.mjs')
  assert.equal(modelFor('next-year'), FALLBACK_MODEL)
})

test('the vendored Three.js is the expected file', () => {
  const dir = path.join(__dirname, '..', 'public', 'vendor', 'three')
  const sha = (name) => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')
  assert.equal(sha('three.module.min.js'), '08fd7545d13d2c7fb65ab691530a802dafefd638596501854f267d0fb13c39e7')
  assert.equal(sha('OrbitControls.js'), '80efaadea4f8a636a65fb0bd08bfef62f3d93a0bb94e2e7500f23176c5c07f4e')
  assert.ok(fs.existsSync(path.join(dir, 'LICENSE')))
})

const walk = () => import('../public/site3d-walk.mjs')
const siteOf = async (n, miners = 60) => {
  const { layoutSite } = await load()
  return layoutSite(Array.from({ length: n }, (_, i) => ({ id: `c${i}`, minerCount: miners })))
}
// Walks a route in small steps, as the game loop would.
function walkRoute (w, start, route, colliders, bounds) {
  let at = { x: start.x, z: start.z }
  for (const point of route) {
    for (let i = 0; i < 2000 && Math.hypot(point.x - at.x, point.z - at.z) > 0.05; i++) {
      const d = Math.hypot(point.x - at.x, point.z - at.z)
      const stepLength = Math.min(0.04, d)
      at = w.move(at, ((point.x - at.x) / d) * stepLength, ((point.z - at.z) / d) * stepLength, colliders, bounds)
    }
  }
  return at
}

test('you start somewhere clear, outside the gate', async () => {
  const w = await walk()
  for (const n of [1, 2, 9, 50]) {
    const site = await siteOf(n)
    const start = w.spawnPoint(site.yard)
    assert.ok(w.isClear(start.x, start.z, w.buildColliders(site)), `${n} containers`)
    assert.ok(start.z > site.yard.fence.maxZ)
  }
})

test('the fence stops you, except at the gate', async () => {
  const w = await walk()
  const site = await siteOf(2)
  const colliders = w.buildColliders(site)
  const { fence } = site.yard
  const beside = { x: fence.gateHalf + 2, z: fence.maxZ + 1 }
  assert.ok(w.move(beside, 0, -3, colliders).z > fence.maxZ, 'blocked by the fence')
  const gate = { x: 0, z: fence.maxZ + 1 }
  assert.ok(w.move(gate, 0, -3, colliders).z < fence.maxZ, 'through the gate')
  const inside = { x: fence.maxX - 1, z: 0 }
  assert.ok(w.move(inside, 3, 0, colliders).x < fence.maxX, 'blocked from inside')
})

test('fast movement can’t jump through a wall', async () => {
  const w = await walk()
  const site = await siteOf(1)
  const colliders = w.buildColliders(site)
  const [container] = site.boxes
  const outside = { x: container.origin.x, z: container.origin.z + container.width / 2 + 1 }
  const after = w.move(outside, 0, -8, colliders)
  assert.ok(after.z > container.origin.z + container.width / 2, `reached ${after.z}`)
})

test('you slide along a wall instead of sticking to it', async () => {
  const w = await walk()
  const site = await siteOf(1)
  const colliders = w.buildColliders(site)
  const [container] = site.boxes
  const start = { x: container.origin.x, z: container.origin.z + container.width / 2 + 0.3 }
  const after = w.move(start, 1, -1, colliders)
  assert.ok(after.x > start.x + 0.9, 'keeps moving along the wall')
  assert.ok(after.z > container.origin.z + container.width / 2, 'but not through it')
})

test('the door opens into an aisle wide enough to walk, at every fleet size', async () => {
  const w = await walk()
  for (const miners of [1, 8, 60, 112, 200, 296, 300, 990]) {
    const site = await siteOf(2, miners)
    const colliders = w.buildColliders(site)
    for (const container of site.boxes) {
      const { x, z } = container.origin
      const door = w.doorPoint(container)
      assert.ok(w.isClear(door.x, door.z, colliders), `outside ${container.id}'s door with ${miners} miners`)
      const inAisle = { x: x + container.length / 2 - 0.5, z }
      const after = walkRoute(w, door, [inAisle], colliders)
      assert.ok(Math.hypot(after.x - inAisle.x, after.z - inAisle.z) < 0.1, `can't walk ${container.id}'s aisle with ${miners} miners, stopped at ${after.x}`)
    }
  }
})

test('you can walk from the road into every container', async () => {
  const w = await walk()
  for (const n of [1, 2, 4, 9]) {
    const site = await siteOf(n)
    const colliders = w.buildColliders(site)
    const bounds = w.walkBounds(site.yard)
    const start = w.spawnPoint(site.yard)
    const { fence } = site.yard
    for (const container of site.boxes) {
      const door = w.doorPoint(container)
      // In through the gate, along the gap in front of the row, then up to the door.
      const route = [
        { x: 0, z: fence.maxZ - 2 },
        { x: door.x, z: fence.maxZ - 2 },
        { x: door.x, z: door.z },
        { x: container.origin.x, z: container.origin.z }
      ]
      const after = walkRoute(w, start, route, colliders, bounds)
      assert.ok(Math.hypot(after.x - container.origin.x, after.z - container.origin.z) < 0.1, `${container.id} of ${n}, stopped at ${after.x}, ${after.z}`)
    }
  }
})

test('you can’t walk off into the distance', async () => {
  const w = await walk()
  const site = await siteOf(1)
  const bounds = w.walkBounds(site.yard)
  const start = w.spawnPoint(site.yard)
  let at = start
  for (let i = 0; i < 500; i++) at = w.move(at, 0, 1, w.buildColliders(site), bounds)
  assert.ok(at.z <= bounds.maxZ)
})

test('walls block your view of a miner, and fences and open air don’t', async () => {
  const w = await walk()
  const site = await siteOf(1)
  const colliders = w.buildColliders(site)
  const [container] = site.boxes
  const { x, z } = container.origin
  const miner = { x, z: z + container.width / 2 - 0.4 }
  assert.equal(w.isBlocked({ x, z }, miner, colliders), false, 'from the aisle')
  assert.equal(w.isBlocked({ x, z: z + container.width / 2 + 1.5 }, miner, colliders), true, 'through the wall')
  const { fence } = site.yard
  assert.equal(w.isBlocked({ x: 0, z: fence.maxZ + 1 }, { x: 0, z: fence.maxZ - 1 }, colliders), false, 'through the fence')
})

test('facing a miner targets it, unless it’s behind you, out of reach or behind a wall', async () => {
  const w = await walk()
  const site = await siteOf(1)
  const colliders = w.buildColliders(site)
  const [container] = site.boxes
  const { x, z } = container.origin
  const centres = new Map([
    ['near', { x, z: z - 0.85 }],
    ['behind', { x: x + 0.1, z: z + 0.85 }],
    ['far', { x, z: z - 40 }]
  ])
  const walker = (yaw) => ({ x, z, yaw })
  assert.equal(w.facingMiner(walker(0), centres, 4, colliders), 'near', 'yaw 0 faces -z')
  assert.equal(w.facingMiner(walker(Math.PI), centres, 4, colliders), 'behind')
  assert.equal(w.facingMiner(walker(Math.PI / 2), centres, 4, colliders), null, 'facing along the aisle')
  assert.equal(w.facingMiner(walker(0), new Map([['far', centres.get('far')]]), 4, colliders), null, 'out of reach')
  const outside = { x, z: z + container.width / 2 + 1, yaw: 0 }
  assert.equal(w.facingMiner(outside, new Map([['inside', { x, z: z + 0.85 }]]), 4, colliders), null, 'behind the wall')
})

test('turning past a full circle still finds what you’re facing', async () => {
  const w = await walk()
  const site = await siteOf(1)
  const colliders = w.buildColliders(site)
  const { x, z } = site.boxes[0].origin
  const centres = new Map([['near', { x, z: z - 0.85 }]])
  assert.equal(w.facingMiner({ x, z, yaw: Math.PI * 4 }, centres, 4, colliders), 'near')
  assert.equal(w.facingMiner({ x, z, yaw: -Math.PI * 2 }, centres, 4, colliders), 'near')
})
