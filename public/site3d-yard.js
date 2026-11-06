// Everything around the miners: container walls, the substation, power runs, the
// fence and the ground. Most of it is scenery, but the power runs, the breaker lamp
// and the masts show the site's real electrical state.

import * as THREE from 'three'
import { DOOR_WIDTH } from './site3d-walk.mjs'

const LIVE = new THREE.Color('#d98f2b')
const DEAD = new THREE.Color('#2a2b2d')
const CONTAINER_PAINT = ['#7d97ab', '#a07a66', '#84967f', '#8e939a', '#a98c6a', '#6f8ea3']
const FENCE_H = 2.4
const FENCE_POST_GAP = 3
const MAST_H = 6
// Redrawing shadows has a cost, so the sun only moves them this often.
const SHADOW_REFRESH_MS = 4000
const DOOR_HEIGHT = 2.1

function canvas (w, h, draw, repeat) {
  const el = document.createElement('canvas')
  el.width = w
  el.height = h
  draw(el.getContext('2d'), w, h)
  const texture = new THREE.CanvasTexture(el)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  if (repeat) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.repeat.set(repeat[0], repeat[1])
  }
  return texture
}

// A fixed pattern rather than Math.random, so the scene looks the same every load.
function speckle (c, w, h, count, colors, seed = 1) {
  for (let i = 0; i < count; i++) {
    const a = Math.sin((i + seed) * 12.9898) * 43758.5453
    const b = Math.sin((i + seed) * 78.233) * 12543.123
    const d = Math.sin((i + seed) * 37.719) * 9631.77
    c.fillStyle = colors[Math.floor((d - Math.floor(d)) * colors.length)]
    c.fillRect((a - Math.floor(a)) * w, (b - Math.floor(b)) * h, 2, 2)
  }
}

function gravelTexture () {
  return canvas(256, 256, (c, w, h) => {
    c.fillStyle = '#6e6c67'
    c.fillRect(0, 0, w, h)
    speckle(c, w, h, 4200, ['#55534f', '#7f7d77', '#8d8a83', '#494845', '#65625c'])
  }, [40, 40])
}

function dirtTexture () {
  return canvas(256, 256, (c, w, h) => {
    c.fillStyle = '#4c4a3e'
    c.fillRect(0, 0, w, h)
    speckle(c, w, h, 2600, ['#403f35', '#575546', '#4a4f3a', '#5c5947'], 7)
  }, [120, 120])
}

function asphaltTexture () {
  return canvas(128, 128, (c, w, h) => {
    c.fillStyle = '#2d2e30'
    c.fillRect(0, 0, w, h)
    speckle(c, w, h, 1400, ['#232426', '#38393b', '#424345'], 3)
  }, [4, 80])
}

// Painted steel with vertical ribs: a door end, greys only so paint can tint it.
function corrugatedTexture () {
  return canvas(256, 128, (c, w, h) => {
    c.fillStyle = '#d9d9d9'
    c.fillRect(0, 0, w, h)
    for (let x = 0; x < w; x += 16) {
      const gradient = c.createLinearGradient(x, 0, x + 16, 0)
      gradient.addColorStop(0, '#f0f0f0')
      gradient.addColorStop(0.5, '#9c9c9c')
      gradient.addColorStop(1, '#efefef')
      c.fillStyle = gradient
      c.fillRect(x, 0, 16, h)
    }
    // Door seam and lock rods.
    c.fillStyle = '#4a4a4a'
    c.fillRect(w / 2 - 1, 4, 2, h - 8)
    c.fillStyle = '#707070'
    for (const x of [w * 0.3, w * 0.42, w * 0.58, w * 0.7]) c.fillRect(x, 4, 2, h - 8)
    c.strokeStyle = '#555'
    c.lineWidth = 2
    c.strokeRect(2, 2, w - 4, h - 4)
  })
}

// The long walls are how the air gets in: louvres over wet evaporative pads.
function intakeTexture () {
  return canvas(512, 128, (c, w, h) => {
    c.fillStyle = '#d4d4d4'
    c.fillRect(0, 0, w, h)
    for (let bay = 0; bay < 6; bay++) {
      const x = 8 + bay * ((w - 8) / 6)
      const bayW = (w - 8) / 6 - 8
      // Cellulose pads behind grey aluminium louvres.
      c.fillStyle = '#b3a587'
      c.fillRect(x, 10, bayW, h - 20)
      c.fillStyle = 'rgba(70, 70, 72, 0.7)'
      for (let y = 12; y < h - 12; y += 7) c.fillRect(x, y, bayW, 3)
      c.strokeStyle = '#555'
      c.lineWidth = 2
      c.strokeRect(x, 10, bayW, h - 20)
    }
  })
}

function chainLinkTexture () {
  return canvas(64, 64, (c, w, h) => {
    c.clearRect(0, 0, w, h)
    c.strokeStyle = '#a8adb2'
    c.lineWidth = 2
    c.beginPath()
    c.moveTo(0, 0); c.lineTo(w, h)
    c.moveTo(w, 0); c.lineTo(0, h)
    c.stroke()
  })
}

function cabinetTexture () {
  return canvas(128, 128, (c, w, h) => {
    c.fillStyle = '#9aa0a5'
    c.fillRect(0, 0, w, h)
    c.strokeStyle = '#555'
    c.lineWidth = 2
    for (let x = 0; x < 4; x++) c.strokeRect(6 + x * 30, 6, 26, h - 12)
    c.fillStyle = '#333'
    for (let x = 0; x < 4; x++) {
      c.fillRect(26 + x * 30, 58, 4, 12)
      for (let y = 18; y < 46; y += 6) c.fillRect(12 + x * 30, y, 14, 2)
    }
  })
}

export class SiteYard {
  constructor (scene, sun, glowTexture) {
    this.scene = scene
    this.sun = sun
    this.glowTexture = glowTexture
    this.objects = []
    this.walls = []
    this.runColors = new Map()
    this.scratch = new THREE.Object3D()
    this.color = new THREE.Color()
    this.lastCamera = new THREE.Vector3(Infinity, 0, 0)

    this.box = new THREE.BoxGeometry(1, 1, 1)
    this.plane = new THREE.PlaneGeometry(1, 1)

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshStandardMaterial({ map: dirtTexture(), roughness: 1 }))
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.06
    ground.receiveShadow = true
    scene.add(ground)

    this.gravelMaterial = new THREE.MeshStandardMaterial({ map: gravelTexture(), roughness: 1 })
    this.roadMaterial = new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.95 })
    this.intakeMaterial = new THREE.MeshStandardMaterial({ map: intakeTexture(), roughness: 0.8, side: THREE.DoubleSide })
    this.endMaterial = new THREE.MeshStandardMaterial({ map: corrugatedTexture(), roughness: 0.75, side: THREE.DoubleSide })
    this.doorMaterial = new THREE.MeshStandardMaterial({ roughness: 0.75 })
    this.roofMaterial = new THREE.MeshStandardMaterial({ color: '#5a5f64', roughness: 0.9, side: THREE.DoubleSide })
    this.onFoot = false
    this.ghostMaterial = new THREE.MeshStandardMaterial({ color: '#b6c6d6', transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide })
    this.caster = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false })
    this.runMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.7 })
    this.feedMaterial = new THREE.MeshStandardMaterial({ color: LIVE.clone(), roughness: 0.7 })
    this.steel = new THREE.MeshStandardMaterial({ color: '#7d848b', roughness: 0.6, metalness: 0.2 })
    this.galvanised = new THREE.MeshStandardMaterial({ color: '#8f969c', roughness: 0.55, metalness: 0.2 })
    this.transformerPaint = new THREE.MeshStandardMaterial({ color: '#5c6b60', roughness: 0.6 })
    this.concrete = new THREE.MeshStandardMaterial({ color: '#7c7b76', roughness: 1 })
    this.cabinet = new THREE.MeshStandardMaterial({ map: cabinetTexture(), roughness: 0.6 })
    this.insulator = new THREE.MeshStandardMaterial({ color: '#7a4d38', roughness: 0.4 })
    this.lampMaterial = new THREE.MeshBasicMaterial({ color: '#3ecf72' })
    this.mastLampMaterial = new THREE.MeshBasicMaterial({ color: '#2a2a28' })
    this.fenceMaterial = new THREE.MeshStandardMaterial({ map: chainLinkTexture(), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.8 })
    this.glowMaterial = new THREE.SpriteMaterial({ map: glowTexture, color: '#ffdca8', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending })
  }

  _add (object) {
    this.objects.push(object)
    this.scene.add(object)
    return object
  }

  _block (material, x, y, z, w, h, d, { cast = true } = {}) {
    const mesh = new THREE.Mesh(this.box, material)
    mesh.position.set(x, y, z)
    mesh.scale.set(w, h, d)
    mesh.castShadow = cast
    return this._add(mesh)
  }

  clear () {
    for (const object of this.objects) {
      this.scene.remove(object)
      if (object.isInstancedMesh) object.dispose()
      if (object.userData.ownsGeometry) object.geometry.dispose()
    }
    this.objects = []
    this.walls = []
    this.runColors.clear()
    this.lastCamera.set(Infinity, 0, 0)
  }

  build (site) {
    this.clear()
    this.site = site
    const { yard, boxes } = site
    this._buildGround(yard)
    this._buildWalls(boxes)
    this._buildPower(yard)
    this._buildSubstation(yard)
    this._buildFence(yard.fence)
    this._buildMasts(yard)
    this._aimShadows(site)
    this.lastShadow = 0
  }

  _buildGround ({ fence, road }) {
    const w = fence.maxX - fence.minX
    const d = fence.maxZ - fence.minZ
    const gravel = new THREE.Mesh(this.plane, this.gravelMaterial)
    gravel.rotation.x = -Math.PI / 2
    gravel.position.set((fence.minX + fence.maxX) / 2, -0.04, (fence.minZ + fence.maxZ) / 2)
    gravel.scale.set(w, d, 1)
    gravel.receiveShadow = true
    this.gravelMaterial.map.repeat.set(w / 3, d / 3)
    this._add(gravel)

    const asphalt = new THREE.Mesh(this.plane, this.roadMaterial)
    asphalt.rotation.x = -Math.PI / 2
    asphalt.position.set(road.x, -0.03, road.fromZ + road.length / 2)
    asphalt.scale.set(road.width, road.length, 1)
    asphalt.receiveShadow = true
    this._add(asphalt)
  }

  // Each container gets three walls and a door end. The walls are sorted into solid
  // and see-through every time the camera moves, so nothing stands between the viewer
  // and the miners. On foot they all stay solid, and the roof goes on.
  _buildWalls (boxes) {
    const { scratch, color } = this
    const longs = new THREE.InstancedMesh(this.plane, this.intakeMaterial, boxes.length * 2)
    const ends = new THREE.InstancedMesh(this.plane, this.endMaterial, boxes.length)
    const ghosts = new THREE.InstancedMesh(this.plane, this.ghostMaterial, boxes.length * 3)
    const shadows = new THREE.InstancedMesh(this.box, this.caster, boxes.length)
    // Two jambs, a lintel and two open door leaves per container.
    const doors = new THREE.InstancedMesh(this.box, this.doorMaterial, boxes.length * 5)
    const roofs = new THREE.InstancedMesh(this.plane, this.roofMaterial, boxes.length)
    ghosts.frustumCulled = longs.frustumCulled = ends.frustumCulled = false
    doors.frustumCulled = roofs.frustumCulled = false
    shadows.castShadow = true
    shadows.frustumCulled = false

    this.walls = []
    boxes.forEach((box, i) => {
      const { x, z } = box.origin
      const h = box.height
      const paint = new THREE.Color(CONTAINER_PAINT[i % CONTAINER_PAINT.length])
      const add = (wx, wz, width, ry, nx, nz, long) => {
        scratch.position.set(wx, h / 2, wz)
        scratch.rotation.set(0, ry, 0)
        scratch.scale.set(width, h, 1)
        scratch.updateMatrix()
        this.walls.push({ matrix: scratch.matrix.clone(), x: wx, z: wz, nx, nz, long, paint })
      }
      add(x, z + box.width / 2, box.length, 0, 0, 1, true)
      add(x, z - box.width / 2, box.length, Math.PI, 0, -1, true)
      add(x + box.length / 2, z, box.width, Math.PI / 2, 1, 0, false)

      // The door end at -x, propped open.
      const endX = x - box.length / 2
      const jamb = (box.width - DOOR_WIDTH) / 2
      const part = (index, px, py, pz, sx, sy, sz) => {
        scratch.position.set(px, py, pz)
        scratch.rotation.set(0, 0, 0)
        scratch.scale.set(sx, sy, sz)
        scratch.updateMatrix()
        doors.setMatrixAt(i * 5 + index, scratch.matrix)
        doors.setColorAt(i * 5 + index, paint)
      }
      part(0, endX, h / 2, z + DOOR_WIDTH / 2 + jamb / 2, 0.08, h, jamb)
      part(1, endX, h / 2, z - DOOR_WIDTH / 2 - jamb / 2, 0.08, h, jamb)
      part(2, endX, (DOOR_HEIGHT + h) / 2, z, 0.08, h - DOOR_HEIGHT, DOOR_WIDTH)
      part(3, endX - DOOR_WIDTH / 2, DOOR_HEIGHT / 2, z + DOOR_WIDTH / 2, DOOR_WIDTH, DOOR_HEIGHT, 0.04)
      part(4, endX - DOOR_WIDTH / 2, DOOR_HEIGHT / 2, z - DOOR_WIDTH / 2, DOOR_WIDTH, DOOR_HEIGHT, 0.04)

      scratch.position.set(x, h, z)
      scratch.rotation.set(Math.PI / 2, 0, 0)
      scratch.scale.set(box.length, box.width, 1)
      scratch.updateMatrix()
      roofs.setMatrixAt(i, scratch.matrix)

      scratch.position.set(x, h / 2, z)
      scratch.rotation.set(0, 0, 0)
      scratch.scale.set(box.length, h, box.width)
      scratch.updateMatrix()
      shadows.setMatrixAt(i, scratch.matrix)
    })
    // The colour buffer's size is set by the first write, so fill it while the meshes are full size.
    color.set('#ffffff')
    for (let i = 0; i < boxes.length * 2; i++) longs.setColorAt(i, color)
    for (let i = 0; i < boxes.length; i++) ends.setColorAt(i, color)
    roofs.visible = this.onFoot
    this.longs = longs
    this.ends = ends
    this.ghosts = ghosts
    this.roofs = roofs
    this._add(longs)
    this._add(ends)
    this._add(ghosts)
    this._add(shadows)
    this._add(doors)
    this._add(roofs)
  }

  // Hides the walls between the viewer and the miners.
  updateCutaway (camera) {
    if (!this.walls.length || camera.position.distanceToSquared(this.lastCamera) < 0.01) return
    this.lastCamera.copy(camera.position)
    let long = 0
    let end = 0
    let ghost = 0
    for (const wall of this.walls) {
      const faces = (camera.position.x - wall.x) * wall.nx + (camera.position.z - wall.z) * wall.nz > 0
      if (faces && !this.onFoot) {
        this.ghosts.setMatrixAt(ghost++, wall.matrix)
      } else if (wall.long) {
        this.longs.setColorAt(long, wall.paint)
        this.longs.setMatrixAt(long++, wall.matrix)
      } else {
        this.ends.setColorAt(end, wall.paint)
        this.ends.setMatrixAt(end++, wall.matrix)
      }
    }
    for (const [mesh, count] of [[this.longs, long], [this.ends, end], [this.ghosts, ghost]]) {
      mesh.count = count
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  }

  setOnFoot (onFoot) {
    this.onFoot = onFoot
    if (this.roofs) this.roofs.visible = onFoot
    this.lastCamera.set(Infinity, 0, 0)
  }

  _buildPower ({ runs }) {
    const total = runs.reduce((sum, run) => sum + run.segments.length, 0)
    const mesh = new THREE.InstancedMesh(this.box, this.runMaterial, total)
    let index = 0
    runs.forEach((run, r) => {
      const indices = []
      for (const seg of run.segments) {
        this.scratch.position.set(seg.x, 0.05 + r * 0.0015, seg.z)
        this.scratch.rotation.set(0, 0, 0)
        this.scratch.scale.set(seg.w, 0.14, seg.d)
        this.scratch.updateMatrix()
        mesh.setMatrixAt(index, this.scratch.matrix)
        mesh.setColorAt(index, LIVE)
        indices.push(index++)
      }
      this.runColors.set(run.id, indices)
    })
    this.runMesh = mesh
    this._add(mesh)
  }

  _buildSubstation ({ substation, spineZ }) {
    const { x, z } = substation
    this._block(this.concrete, x, 0.06, z, 10, 0.12, 6.4, { cast: false }).receiveShadow = true

    // Transformer: tank, cooling fins, conservator and three high-voltage bushings.
    const { transformer, switchgear } = this.site.yard
    this._block(this.transformerPaint, x + transformer.x, 1.15, z + transformer.z, 2.3, 2.1, 1.7)
    const fins = new THREE.InstancedMesh(this.box, this.transformerPaint, 22)
    for (let i = 0; i < 22; i++) {
      const side = i % 2 === 0 ? 1 : -1
      this.scratch.position.set(x - 2.65 + Math.floor(i / 2) * 0.2, 1.1, z + side * 1.05)
      this.scratch.rotation.set(0, 0, 0)
      this.scratch.scale.set(0.08, 1.6, 0.42)
      this.scratch.updateMatrix()
      fins.setMatrixAt(i, this.scratch.matrix)
    }
    fins.castShadow = true
    this._add(fins)
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1.5, 12), this.transformerPaint)
    drum.userData.ownsGeometry = true
    drum.rotation.z = Math.PI / 2
    drum.position.set(x - 1.6, 2.55, z - 0.6)
    this._add(drum)
    const bushing = new THREE.CylinderGeometry(0.07, 0.11, 0.7, 8)
    for (const dx of [-0.7, 0, 0.7]) {
      const mesh = new THREE.Mesh(bushing, this.insulator)
      mesh.position.set(x - 1.6 + dx, 2.55, z + 0.35)
      this._add(mesh)
    }

    // Switchgear, with the main breaker's lamp on top.
    this._block(this.cabinet, x + switchgear.x, 1.1, z + switchgear.z, switchgear.w, 2.1, switchgear.d)
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), this.lampMaterial)
    lamp.userData.ownsGeometry = true
    lamp.position.set(x + switchgear.x, 2.32, z + switchgear.z)
    this._add(lamp)

    // Feed from the switchgear down to the power spine.
    this._block(this.feedMaterial, x, 0.05, (z + spineZ) / 2, 0.36, 0.14, Math.abs(spineZ - z), { cast: false })

    // A pole outside the fence bringing in the utility's line.
    const { fence } = this.site.yard
    const poleZ = fence.minZ - 4
    this._block(this.steel, x - 1.6, 4, poleZ, 0.28, 8, 0.28)
    this._block(this.steel, x - 1.6, 7.7, poleZ, 2.4, 0.14, 0.14)
    const points = []
    for (const dx of [-0.7, 0, 0.7]) {
      points.push(new THREE.Vector3(x - 1.6 + dx, 7.8, poleZ), new THREE.Vector3(x - 1.6 + dx, 2.9, z + 0.35))
      points.push(new THREE.Vector3(x - 1.6 + dx, 7.8, poleZ), new THREE.Vector3(x - 1.6 + dx * 6, 7.8, poleZ - 300))
    }
    const wires = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: '#191a1c' }))
    wires.userData.ownsGeometry = true
    this._add(wires)
  }

  _buildFence (fence) {
    const { minX, maxX, minZ, maxZ, gateHalf } = fence
    // Two runs along the front, either side of the gate.
    const runs = [
      [minX, maxZ, -gateHalf, maxZ],
      [gateHalf, maxZ, maxX, maxZ],
      [maxX, maxZ, maxX, minZ],
      [maxX, minZ, minX, minZ],
      [minX, minZ, minX, maxZ]
    ]
    const positions = []
    const uvs = []
    const indices = []
    const posts = []
    runs.forEach(([x1, z1, x2, z2]) => {
      const length = Math.hypot(x2 - x1, z2 - z1)
      const base = positions.length / 3
      positions.push(x1, 0, z1, x2, 0, z2, x2, FENCE_H, z2, x1, FENCE_H, z1)
      uvs.push(0, 0, length * 3, 0, length * 3, FENCE_H * 3, 0, FENCE_H * 3)
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
      const count = Math.max(1, Math.round(length / FENCE_POST_GAP))
      for (let i = 0; i <= count; i++) {
        posts.push([x1 + ((x2 - x1) * i) / count, z1 + ((z2 - z1) * i) / count])
      }
    })
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    this.fenceMaterial.map.wrapS = this.fenceMaterial.map.wrapT = THREE.RepeatWrapping
    const mesh = new THREE.Mesh(geometry, this.fenceMaterial)
    mesh.userData.ownsGeometry = true
    this._add(mesh)

    const postMesh = new THREE.InstancedMesh(this.box, this.galvanised, posts.length)
    posts.forEach(([x, z], i) => {
      this.scratch.position.set(x, FENCE_H / 2, z)
      this.scratch.rotation.set(0, 0, 0)
      this.scratch.scale.set(0.07, FENCE_H, 0.07)
      this.scratch.updateMatrix()
      postMesh.setMatrixAt(i, this.scratch.matrix)
    })
    postMesh.castShadow = true
    this._add(postMesh)
  }

  _buildMasts ({ masts }) {
    for (const { x, z } of masts) {
      this._block(this.steel, x, MAST_H / 2, z, 0.12, MAST_H, 0.12)
      this._block(this.mastLampMaterial, x, MAST_H, z, 0.5, 0.1, 0.24, { cast: false })
      const glow = new THREE.Sprite(this.glowMaterial)
      glow.position.set(x, MAST_H, z)
      glow.scale.setScalar(4)
      this._add(glow)
    }
  }

  _aimShadows (site) {
    const r = site.radius + 8
    const shadow = this.sun.shadow
    shadow.camera.left = -r
    shadow.camera.right = r
    shadow.camera.top = r
    shadow.camera.bottom = -r
    shadow.camera.near = 1
    shadow.camera.far = r * 4
    shadow.camera.updateProjectionMatrix()
    this.sun.target.position.set(site.centre.x, 0, site.centre.z)
    this.sun.target.updateMatrixWorld()
  }

  // Moves the sun, and repaints shadows only now and then, because they're costly.
  placeSun (hour, renderer, now) {
    if (!this.site) return
    const angle = ((hour - 6) / 12) * Math.PI
    const r = this.site.radius + 12
    const up = Math.max(0.08, Math.sin(angle))
    this.sun.position.set(this.site.centre.x + Math.cos(angle) * r, up * r * 1.2, this.site.centre.z + r * 0.45)
    if (now - this.lastShadow > SHADOW_REFRESH_MS) {
      this.lastShadow = now
      renderer.shadowMap.needsUpdate = true
    }
  }

  // The parts of the scene that show the site's electrical state.
  update (state, daylight) {
    const { site, containers } = state
    const siteLive = !site.gridDown && !site.breakerOpen

    this.lampMaterial.color.set(siteLive ? '#3ecf72' : '#ff3b30')
    this.feedMaterial.color.copy(siteLive ? LIVE : DEAD)
    for (const container of containers) {
      const indices = this.runColors.get(container.id)
      if (!indices) continue
      const live = siteLive && !container.fx.pduOff
      for (const index of indices) this.runMesh.setColorAt(index, live ? LIVE : DEAD)
    }
    if (this.runMesh?.instanceColor) this.runMesh.instanceColor.needsUpdate = true

    // Yard lights come on at dusk, if there's power to run them.
    const lit = siteLive && daylight < 0.25
    this.mastLampMaterial.color.set(lit ? '#ffe2b0' : '#2a2a28')
    this.glowMaterial.opacity = lit ? 0.7 : 0
  }
}
