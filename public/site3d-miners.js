// Draws the miners. Everything is instanced, one mesh per part, so a thousand
// machines cost about the same number of draw calls as ten. Textures are drawn
// here in code, in greys, so each miner's own colour can tint them.

import * as THREE from 'three'
import { modelFor, partsFor } from './site3d-models.mjs'

// Beyond this the blades only strobe, so they stop looking like spinning.
const MAX_BLADE_RAD_S = 11
// How much of the status colour shows on the metal. The LED strip shows all of it.
// Far away a miner is only a few pixels, so colour has to carry it.
const BODY_TINT_NEAR = 0.3
const BODY_TINT_FAR = 0.8
// How big a fan must appear, in pixels, before each detail is worth drawing.
const FANS_FROM_PX = 14
const GUARDS_FROM_PX = 30
const MARKER_LIFT = 0.1

function canvas (size, draw, srgb = true) {
  const el = document.createElement('canvas')
  el.width = el.height = size
  draw(el.getContext('2d'), size)
  const texture = new THREE.CanvasTexture(el)
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

// Sheet metal with panel seams, a row of vent slots and screws.
function sideTexture () {
  return canvas(256, (c, s) => {
    c.fillStyle = '#e4e4e4'
    c.fillRect(0, 0, s, s)
    for (let i = 0; i < 90; i++) {
      c.fillStyle = `rgba(0,0,0,${0.01 + (i % 5) * 0.004})`
      c.fillRect(0, (i / 90) * s, s, 2)
    }
    c.fillStyle = '#3a3a3a'
    for (let row = 0; row < 3; row++) {
      for (let x = 34; x < s - 34; x += 16) c.fillRect(x, 46 + row * 22, 9, 12)
    }
    c.strokeStyle = 'rgba(0,0,0,0.45)'
    c.lineWidth = 3
    c.strokeRect(8, 8, s - 16, s - 16)
    c.fillStyle = '#666'
    for (const x of [18, s - 18]) {
      for (const y of [18, s - 18]) {
        c.beginPath()
        c.arc(x, y, 5, 0, Math.PI * 2)
        c.fill()
      }
    }
  })
}

// The chassis end behind the fans: a frame around a perforated panel.
function endTexture () {
  return canvas(256, (c, s) => {
    c.fillStyle = '#d6d6d6'
    c.fillRect(0, 0, s, s)
    c.fillStyle = '#1b1b1b'
    c.fillRect(14, 14, s - 28, s - 28)
    c.fillStyle = '#6a6a6a'
    for (let y = 22; y < s - 18; y += 11) {
      for (let x = 22 + ((y / 11) % 2) * 5; x < s - 18; x += 11) {
        c.beginPath()
        c.arc(x, y, 3, 0, Math.PI * 2)
        c.fill()
      }
    }
  })
}

function psuTexture () {
  return canvas(128, (c, s) => {
    c.fillStyle = '#d8d8d8'
    c.fillRect(0, 0, s, s)
    c.fillStyle = '#2a2a2a'
    for (let y = 16; y < s - 12; y += 12) c.fillRect(14, y, s - 28, 5)
  })
}

// The fan's square housing, with a dark throat and corner screws.
function housingTexture () {
  return canvas(128, (c, s) => {
    c.clearRect(0, 0, s, s)
    c.fillStyle = '#2b2d30'
    c.beginPath()
    c.roundRect(2, 2, s - 4, s - 4, 12)
    c.fill()
    c.fillStyle = '#08090a'
    c.beginPath()
    c.arc(s / 2, s / 2, s * 0.45, 0, Math.PI * 2)
    c.fill()
    c.fillStyle = '#8a8d90'
    for (const x of [12, s - 12]) {
      for (const y of [12, s - 12]) {
        c.beginPath()
        c.arc(x, y, 4, 0, Math.PI * 2)
        c.fill()
      }
    }
  })
}

function bladesTexture () {
  return canvas(128, (c, s) => {
    c.clearRect(0, 0, s, s)
    c.translate(s / 2, s / 2)
    c.fillStyle = '#b4b7ba'
    for (let i = 0; i < 7; i++) {
      c.save()
      c.rotate((i * Math.PI * 2) / 7)
      c.beginPath()
      c.moveTo(s * 0.1, -s * 0.03)
      c.quadraticCurveTo(s * 0.3, -s * 0.2, s * 0.43, -s * 0.05)
      c.quadraticCurveTo(s * 0.32, s * 0.03, s * 0.1, s * 0.05)
      c.closePath()
      c.fill()
      c.restore()
    }
    c.fillStyle = '#3c3f43'
    c.beginPath()
    c.arc(0, 0, s * 0.14, 0, Math.PI * 2)
    c.fill()
  })
}

function guardTexture () {
  return canvas(128, (c, s) => {
    c.clearRect(0, 0, s, s)
    c.translate(s / 2, s / 2)
    c.strokeStyle = '#6f7276'
    c.lineWidth = 2
    for (const r of [0.16, 0.26, 0.36, 0.45]) {
      c.beginPath()
      c.arc(0, 0, s * r, 0, Math.PI * 2)
      c.stroke()
    }
    for (let i = 0; i < 4; i++) {
      c.rotate(Math.PI / 4)
      c.beginPath()
      c.moveTo(-s * 0.45, 0)
      c.lineTo(s * 0.45, 0)
      c.stroke()
    }
  })
}

export class MinerFleet {
  constructor (scene, reducedMotion) {
    this.scene = scene
    this.reducedMotion = reducedMotion
    this.meshes = []
    this.chassis = []
    this.indexOf = new Map()
    this.centres = new Map()
    this.spinners = []
    this.pulsing = []

    this.scratch = new THREE.Object3D()
    this.color = new THREE.Color()
    this.tint = new THREE.Color()

    this.boxGeometry = new THREE.BoxGeometry(1, 1, 1)
    // Two groups instead of the box's six: sides and ends. That's a third of the draw calls.
    this.boxGeometry.clearGroups()
    this.boxGeometry.addGroup(0, 24, 0)
    this.boxGeometry.addGroup(24, 12, 1)
    this.planeGeometry = new THREE.PlaneGeometry(1, 1)

    const side = new THREE.MeshStandardMaterial({ map: sideTexture(), roughness: 0.6, metalness: 0.1 })
    const end = new THREE.MeshStandardMaterial({ map: endTexture(), roughness: 0.7, metalness: 0.1 })
    this.sideMap = side.map
    this.endMap = end.map
    this.endMaterial = end
    this.chassisMaterial = [side, end]
    this.rackMaterial = new THREE.MeshStandardMaterial({ color: '#4c5157', roughness: 0.7, metalness: 0.2 })
    this.detail = { fans: false, guards: false }
    this.psuMaterial = new THREE.MeshStandardMaterial({ map: psuTexture(), roughness: 0.55, metalness: 0.1 })
    // Unlit, so a status colour reads the same at any time of day.
    this.ledMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff' })
    const flat = (map) => new THREE.MeshStandardMaterial({ map, alphaTest: 0.5, roughness: 0.6 })
    this.housingMaterial = flat(housingTexture())
    this.bladesMaterial = flat(bladesTexture())
    this.guardMaterial = flat(guardTexture())
    this.markerGeometry = new THREE.ConeGeometry(0.075, 0.15, 4)
    this.markerMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff' })
  }

  _mesh (geometry, material, count) {
    const mesh = new THREE.InstancedMesh(geometry, material, count)
    this.meshes.push(mesh)
    this.scene.add(mesh)
    return mesh
  }

  clear () {
    for (const mesh of this.meshes) {
      this.scene.remove(mesh)
      mesh.dispose()
    }
    this.meshes = []
    this.chassis = []
    this.groups = []
    this.indexOf.clear()
    this.centres.clear()
    this.spinners = []
  }

  build (state, boxes) {
    this.clear()
    const { scratch } = this

    // Slot centres in world space.
    const placed = []
    for (const box of boxes) {
      const inside = state.miners.filter((m) => m.c === box.id)
      inside.forEach((m, i) => {
        const p = box.positions[i]
        placed.push({ miner: m, x: box.origin.x + p.x, y: p.y, z: box.origin.z + p.z })
      })
    }

    // One set of meshes per model, because each has its own proportions and metal.
    const byModel = new Map()
    for (const entry of placed) {
      if (!byModel.has(entry.miner.model)) byModel.set(entry.miner.model, [])
      byModel.get(entry.miner.model).push(entry)
    }

    const put = (mesh, index, x, y, z, sx, sy, sz, ry = 0) => {
      scratch.position.set(x, y, z)
      scratch.rotation.set(0, ry, 0)
      scratch.scale.set(sx, sy, sz)
      scratch.updateMatrix()
      mesh.setMatrixAt(index, scratch.matrix)
    }

    let fanCount = 0
    for (const [id, entries] of byModel) fanCount += entries.length * modelFor(id).fans * 2
    const housing = this._mesh(this.planeGeometry, this.housingMaterial, fanCount)
    const blades = this._mesh(this.planeGeometry, this.bladesMaterial, fanCount)
    const guard = this._mesh(this.planeGeometry, this.guardMaterial, fanCount)
    let fan = 0

    const rackCount = boxes.reduce((sum, box) => sum + box.racks.length, 0)
    const racks = this._mesh(this.boxGeometry, this.rackMaterial, rackCount)
    let rack = 0
    for (const box of boxes) {
      for (const part of box.racks) {
        put(racks, rack++, box.origin.x + part.x, part.y, box.origin.z + part.z, part.w, part.h, part.d)
      }
    }

    this.groups = []
    for (const [id, entries] of byModel) {
      const model = modelFor(id)
      const parts = partsFor(model)
      const body = this._mesh(this.boxGeometry, this.chassisMaterial, entries.length)
      const led = this._mesh(this.boxGeometry, this.ledMaterial, entries.length)
      const psu = parts.psu ? this._mesh(this.boxGeometry, this.psuMaterial, entries.length) : null
      body.userData.ids = entries.map((entry) => entry.miner.id)
      this.chassis.push(body)
      const metal = new THREE.Color(model.metal)
      const psuMetal = new THREE.Color(model.psuMetal)

      entries.forEach((entry, index) => {
        const { x, y, z, miner } = entry
        put(body, index, x, y + parts.body.y, z, parts.body.w, parts.body.h, parts.body.d)
        put(led, index, x, y + parts.led.y, z, parts.led.w, parts.led.h, parts.led.d)
        if (psu) {
          put(psu, index, x, y + parts.psu.y, z, parts.psu.w, parts.psu.h, parts.psu.d)
          psu.setColorAt(index, psuMetal)
        }
        body.setColorAt(index, metal)
        led.setColorAt(index, this.color.set('#3c3932'))
        this.indexOf.set(miner.id, { group: this.groups.length, index })
        this.centres.set(miner.id, { x, y, z, top: y + parts.led.y + (parts.psu ? model.psuH : 0) })

        for (const f of parts.fans) {
          const ry = f.side > 0 ? 0 : Math.PI
          const s = parts.fanSize
          put(housing, fan, x, y + f.y, z + f.z, s, s, 1, ry)
          put(blades, fan, x, y + f.y, z + f.z + f.side * 0.002, s, s, 1, ry)
          put(guard, fan, x, y + f.y, z + f.z + f.side * 0.004, s, s, 1, ry)
          this.spinners.push({ id: miner.id, x, y: y + f.y, z: z + f.z + f.side * 0.002, s, ry, angle: (fan * 1.7) % 6.28, rate: 0 })
          fan++
        }
      })
      this.groups.push({ body, led, metal })
    }

    this.markers = this._mesh(this.markerGeometry, this.markerMaterial, state.miners.length)
    this.markers.count = 0
    this.markers.frustumCulled = false

    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true
      if (mesh !== this.markers) mesh.computeBoundingSphere()
    }
    this.housing = housing
    this.blades = blades
    this.guard = guard
    this._applyDetail()
  }

  // Called each frame with how large a fan appears on screen.
  setFanPixels (px) {
    const fans = px >= FANS_FROM_PX
    const guards = px >= GUARDS_FROM_PX
    if (fans === this.detail.fans && guards === this.detail.guards) return
    const recolor = fans !== this.detail.fans
    this.detail = { fans, guards }
    this._applyDetail()
    if (recolor && this.lastState) this.update(this.lastState, this.lastColorFor)
  }

  _applyDetail () {
    if (!this.blades) return
    const { fans, guards } = this.detail
    this.housing.visible = fans
    this.blades.visible = fans
    this.guard.visible = guards
    // Without fans in front, the dark vented end would hide the colour.
    this.endMaterial.map = fans ? this.endMap : this.sideMap
  }

  // Applies live state. Fans run at the miner's real speed, so a failed one stops.
  update (state, colorFor) {
    const { color, tint, scratch } = this
    this.lastState = state
    this.lastColorFor = colorFor
    const bodyTint = this.detail.fans ? BODY_TINT_NEAR : BODY_TINT_FAR
    const rates = new Map()
    this.pulsing = []
    let markers = 0

    for (const m of state.miners) {
      const where = this.indexOf.get(m.id)
      if (!where) continue
      const { body, led, metal } = this.groups[where.group]
      const status = colorFor(m)
      color.set(status)
      led.setColorAt(where.index, color)
      tint.copy(metal).lerp(color, bodyTint)
      body.setColorAt(where.index, tint)
      if (m.s === 'tripped' || m.s === 'failed') this.pulsing.push(m.id)

      const failed = m.flt.includes('fan')
      rates.set(m.id, failed || m.s === 'off' ? 0 : (m.fan / 100) * MAX_BLADE_RAD_S)

      if (m.flt.length) {
        const c = this.centres.get(m.id)
        scratch.position.set(c.x, c.top + MARKER_LIFT, c.z)
        scratch.rotation.set(Math.PI, 0, 0)
        scratch.scale.setScalar(1)
        scratch.updateMatrix()
        this.markers.setMatrixAt(markers++, scratch.matrix)
      }
    }
    this.markers.count = markers
    this.markers.instanceMatrix.needsUpdate = true
    for (const { body, led } of this.groups) {
      body.instanceColor.needsUpdate = true
      led.instanceColor.needsUpdate = true
    }
    for (const spinner of this.spinners) spinner.rate = rates.get(spinner.id) ?? 0
  }

  animate (dt, t) {
    if (this.reducedMotion || !this.blades) return
    const { scratch, color } = this

    // Fans too small to see don't need turning.
    if (this.detail.fans) {
      this.spinners.forEach((spinner, index) => {
        if (spinner.rate === 0 && spinner.settled) return
        spinner.angle += spinner.rate * dt
        spinner.settled = spinner.rate === 0
        scratch.position.set(spinner.x, spinner.y, spinner.z)
        scratch.rotation.set(0, spinner.ry, spinner.angle)
        scratch.scale.set(spinner.s, spinner.s, 1)
        scratch.updateMatrix()
        this.blades.setMatrixAt(index, scratch.matrix)
      })
      this.blades.instanceMatrix.needsUpdate = true
    }

    // Tripped machines flash, which reads across a big yard.
    if (this.pulsing.length) {
      const glow = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 7))
      const touched = new Set()
      for (const id of this.pulsing) {
        const where = this.indexOf.get(id)
        const { led } = this.groups[where.group]
        led.setColorAt(where.index, color.set('#e5604d').multiplyScalar(glow))
        touched.add(led)
      }
      for (const led of touched) led.instanceColor.needsUpdate = true
    }
  }

  pick (raycaster) {
    return this.pickHit(raycaster)?.id ?? null
  }

  pickHit (raycaster) {
    const hit = raycaster.intersectObjects(this.chassis, false)[0]
    return hit ? { id: hit.object.userData.ids[hit.instanceId], distance: hit.distance } : null
  }

  centreOf (id) {
    return this.centres.get(id) || null
  }

  get stats () {
    return {
      markers: this.markers?.count ?? 0,
      pulsing: this.pulsing.length,
      fans: this.spinners.length,
      stoppedFans: this.spinners.filter((s) => s.rate === 0).length,
      moving: this.spinners.filter((s) => s.rate > 0).length,
      detail: this.detail
    }
  }
}
