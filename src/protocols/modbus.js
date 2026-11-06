'use strict'

const net = require('net')

const FC_READ_HOLDING = 0x03
const FC_READ_INPUT = 0x04
const EX_ILLEGAL_FUNCTION = 0x01
const EX_ILLEGAL_ADDRESS = 0x02
const MBAP_HEADER = 7
const MAX_QUANTITY = 125

// Minimal Modbus TCP server for register reads. `readRegister(address, unitId)`
// takes a zero-based wire address and returns a uint16, or null when unmapped.
class ModbusServer {
  constructor ({ port, host, readRegister, onRequest }) {
    this.port = port
    this.host = host
    this.readRegister = readRegister
    this.onRequest = onRequest
    this.sockets = new Set()
  }

  start () {
    this.server = net.createServer((socket) => this._onConnection(socket))
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, this.host, resolve)
    })
  }

  _onConnection (socket) {
    this.sockets.add(socket)
    let buffer = Buffer.alloc(0)
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      // A TCP read may hold part of a frame, or several frames.
      while (buffer.length >= MBAP_HEADER) {
        const frameLength = 6 + buffer.readUInt16BE(4)
        if (frameLength < MBAP_HEADER + 1 || frameLength > 260) {
          socket.destroy()
          return
        }
        if (buffer.length < frameLength) break
        socket.write(this._handle(buffer.subarray(0, frameLength)))
        buffer = buffer.subarray(frameLength)
      }
    })
  }

  _handle (frame) {
    const tid = frame.readUInt16BE(0)
    const unitId = frame.readUInt8(6)
    const fc = frame.readUInt8(7)
    if (this.onRequest) this.onRequest()

    if (fc !== FC_READ_HOLDING && fc !== FC_READ_INPUT) return this._exception(tid, unitId, fc, EX_ILLEGAL_FUNCTION)
    if (frame.length < 12) return this._exception(tid, unitId, fc, EX_ILLEGAL_ADDRESS)
    const address = frame.readUInt16BE(8)
    const quantity = frame.readUInt16BE(10)
    if (quantity < 1 || quantity > MAX_QUANTITY) return this._exception(tid, unitId, fc, EX_ILLEGAL_ADDRESS)

    const data = Buffer.alloc(quantity * 2)
    for (let i = 0; i < quantity; i++) {
      const value = this.readRegister(address + i, unitId)
      if (value === null || value === undefined) return this._exception(tid, unitId, fc, EX_ILLEGAL_ADDRESS)
      data.writeUInt16BE(value & 0xFFFF, i * 2)
    }

    const out = Buffer.alloc(9 + data.length)
    out.writeUInt16BE(tid, 0)
    out.writeUInt16BE(0, 2)
    out.writeUInt16BE(3 + data.length, 4)
    out.writeUInt8(unitId, 6)
    out.writeUInt8(fc, 7)
    out.writeUInt8(data.length, 8)
    data.copy(out, 9)
    return out
  }

  _exception (tid, unitId, fc, code) {
    const out = Buffer.alloc(9)
    out.writeUInt16BE(tid, 0)
    out.writeUInt16BE(0, 2)
    out.writeUInt16BE(3, 4)
    out.writeUInt8(unitId, 6)
    out.writeUInt8(fc | 0x80, 7)
    out.writeUInt8(code, 8)
    return out
  }

  async stop () {
    for (const socket of this.sockets) socket.destroy()
    if (this.server) await new Promise((resolve) => this.server.close(resolve))
  }
}

module.exports = ModbusServer
