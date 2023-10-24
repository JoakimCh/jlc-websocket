/*
Allow passthrough controlled by us (so it can't end it) pipe into it to stream a message. E.g. call 

Also allow to send messages using buffer.
*/
// import * as stream from 'node:stream'
import {Opcode, validServerCodes} from './protocolRelated.js'
import {Masker} from './masker.js'
import {Mutex, WebSocketError, drainPromise, BufferStream} from './div.js'
import * as zlib from 'node:zlib'

/** Pipe it into the output and then pipe data into it and it will automatically apply frames and fragmentation. */
export class ProtocolWriter {
  #isClient; minFragmentSize; #maxFragmentSize
  #masker = new Masker(); #zeroMasking
  #msgMutex = new Mutex()
  #frameMutex = new Mutex()
  #ioStream // what to write to
  checkCloseCode = true
  #deflater//; deflatedChunks = []
  #compression
  #keepSlidingWindow
  #errorHandler
  bufferedAmount = 0
  jsonMode

  constructor({webSocket, ioStream, errorHandler}) {
    Object.seal(this) // this is useful to prevent mistakes
    this.#ioStream = ioStream
    this.#isClient =  webSocket.isClient
    this.#errorHandler = errorHandler
    // this.minFragmentSize = webSocket.config.minFragmentSize
    this.jsonMode = webSocket.jsonMode
    this.#zeroMasking = webSocket.config.zeroMasking
    this.#maxFragmentSize = webSocket.config.maxFragmentSize
    if (webSocket.config.compression) {
      this.#compression = webSocket.config.compression
      this.#keepSlidingWindow = this.#isClient ? this.#compression.clientKeepSlidingWindow : this.#compression.serverKeepSlidingWindow
      this.#deflater = new zlib.createDeflateRaw({
        windowBits: this.#isClient ? 
          this.#compression.clientMaxWindowBits : this.#compression.serverMaxWindowBits
      })
      this.#deflater.on('error', error => this.#error(1011, 'deflater error: '+error))
    }
  }

  /** Send a message using a stream. */
  async sendStream(stream, isString, compress) {
    const {unlock} = await this.#msgMutex.lock() // is unlocked after final fragment
    if (!this.#ioStream.writable) return unlock()
    let frameNum = 0
    stream.once('close', async () => {
      await this.#writeFrame(Opcode.continuation, null, false, true)
      unlock()
    })
    stream.on('data', async data => { // if (!data.length) return
      if (data.length <= this.#maxFragmentSize) {
        await this.#writeFrame(frameNum++ == 0 ? (isString ? Opcode.text : Opcode.binary) : Opcode.continuation, data, compress, false)
      } else {
        for (let offset = 0; offset < data.length; offset += this.#maxFragmentSize) {
          const endOffset = offset + this.#maxFragmentSize
          const success = await this.#writeFrame(frameNum++ == 0 ? (isString ? Opcode.text : Opcode.binary) : Opcode.continuation, data.subarray(offset, endOffset), compress, false)
          if (!success) {
            stream.destroy(Error('WebSocket write error.'))
            // this.#error(1011, 'ioStream write error')
            break
          }
        }
      }
    })
    await this.#msgMutex.lockPromise // await unlock
  }

  async send(data, allowCompression) {
    const typeError = 'Data sent with message() must either be a String, Buffer, ArrayBuffer, TypedArray, DataView or Blob.'
    let isString = typeof data == 'string'
    if (isString) {
      if (this.jsonMode) data = JSON.stringify(data)
    } else {
      if (data instanceof Buffer) {
        // all is good then
      } else if (data instanceof ArrayBuffer) {
        data = Buffer.from(data)
      } else if (ArrayBuffer.isView(data)) {
        data = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      } else if (data instanceof Blob) {
        data = Buffer.from(await data.arrayBuffer())
      } else if (this.jsonMode) {
        try {
          data = JSON.stringify(data)
          isString = true
        } catch (error) {
          throw new WebSocketError('TYPE_ERROR', 'jsonMode is true but the data was not compatible with JSON.stringify.', {cause: error})
        }
      } else {
        throw new WebSocketError('TYPE_ERROR', typeError)
      }
    }
    if (isString) data = Buffer.from(data)
    const compress = (() => {
      if (this.#compression && allowCompression) {
        if (this.#compression.keepSlidingWindow) {
          if (data.length >= this.#compression.thresholdWithContext) return true
        } else {
          if (data.length >= this.#compression.thresholdNoContext) return true
        }
      }
    })()
    this.bufferedAmount += data.length
    const {unlock} = await this.#msgMutex.lock()
    if (!this.#ioStream.writable) return unlock()
    if (data.length <= this.#maxFragmentSize) {
      await this.#writeFrame(isString ? Opcode.text : Opcode.binary, data, compress, true)
    } else {
      let offset = 0
      await this.#writeFrame(isString ? Opcode.text : Opcode.binary, data.subarray(offset, this.#maxFragmentSize), compress, false)
      for (offset = this.#maxFragmentSize; offset < data.length; offset += this.#maxFragmentSize) {
        const endOffset = offset + this.#maxFragmentSize
        const success = await this.#writeFrame(Opcode.continuation, data.subarray(offset, endOffset), compress, endOffset >= data.length)
        if (!success) break
      }
    }
    unlock()
    this.bufferedAmount -= data.length
  }

  async close(code, reason) {
    const {_unlock} = await this.#msgMutex.lock() // queue itself after any messages (wait until all sent)
    if (!this.#ioStream.writable) return
    if (this.checkCloseCode) { // if not internal use
      if (!((this.#isClient && code == 1000)
         || (!this.#isClient && validServerCodes.includes(code))
         || (code >= 3000 && code <= 4999))) {
        throw new WebSocketError('INVALID_CODE', 'Tried to close the connection with an invalid code: '+code)
      }
    }
    let payload
    if (typeof reason == 'string') {
      if (reason.length > 123) reason = reason.slice(0, 123)
      payload = Buffer.from('xx'+reason)
      if (payload.length > 125) {
        throw new WebSocketError('INVALID_REASON', 'Tried to close the connection with a reason longer than 123 bytes (UTF-8 encoded).')
      }
    } else {
      payload = Buffer.allocUnsafe(2)
    }
    payload.writeUInt16BE(code, 0)
    return await this.#writeFrame(Opcode.close, payload) // true if sent
    // unlock() // do not unlock because nothing more should be sent
  }

  ping(payload) {
    if (payload) {
      if (payload instanceof Buffer) {
        // all is good then
      } else if (payload instanceof ArrayBuffer) {
        payload = Buffer.from(payload)
      } else if (ArrayBuffer.isView(payload)) {
        payload = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
      } else {
        throw new WebSocketError('TYPE_ERROR', 'Data sent with ping() must either be a Buffer, ArrayBuffer, TypedArray or DataView.')
      }
    }
    return this.#writeFrame(Opcode.ping, payload)
  }
  
  pong(payload) {
    return this.#writeFrame(Opcode.pong, payload)
  }

  async #write(data) {
    if (this.#ioStream.writableNeedDrain) {
      await new Promise((resolve, reject) => {
        this.#ioStream.once('error', reject)
        this.#ioStream.once('drain', () => {
          this.#ioStream.off('error', reject) // remove it then
          resolve()
        })
      })
    }
    this.#ioStream.write(data)
  }

  #error(code, reason) {
    this.#errorHandler({code, reason})
  }

  async #writeFrame(opcode, payload, compress, isFinal) {
    if (opcode == undefined) throw Error('No opcode set.')
    const {unlock} = await this.#frameMutex.lock() // wait until any other frame is fully transmitted
    if (!this.#ioStream.writable) return
    let mask
    if (this.#isClient) mask = this.#zeroMasking ? 0 : this.#masker.newMask()
    try {
      if (payload?.length) {
        if (compress) payload = await this.#compressPayload(payload, isFinal)
        if (this.#isClient && !this.#zeroMasking) this.#masker.maskInPlace(payload)
      }
      const head = frameHeader({opcode, isFinal, payloadSize: payload?.length, mask, compressionBit: opcode == Opcode.continuation ? false : compress})
      await this.#write(head)
      if (payload?.length) await this.#write(payload)
    } catch (error) {      
      this.#error(1011, 'ioStream write error: '+error)
    }
    unlock()
    return !this.#ioStream.errored
  }

  #compressPayload(payload, isFinal) {
    return new Promise(async (resolve, reject) => {
      const deflatedChunks = []
      const onData = data => {deflatedChunks.push(data)}
      this.#deflater.on('data', onData)
      if (this.#deflater.writableNeedDrain) await drainPromise(this.#deflater) // never seen this happen, but just in case
      this.#deflater.write(payload, error => {
        if (error) return reject(error)
        this.#deflater.flush(isFinal && !this.#keepSlidingWindow ? zlib.constants.Z_FULL_FLUSH : zlib.constants.Z_SYNC_FLUSH, error => {
          this.#deflater.off('data', onData)
          if (error) return reject(error)
          if (!deflatedChunks.length) return reject(Error('WTF?'))
          const compressedData = Buffer.concat(deflatedChunks)
          if (isFinal) { // then remove ZZZZFFFF
            resolve(compressedData.subarray(0, compressedData.length - 4))
          } else {
            resolve(compressedData)
          }
        })
      })
    })
  }
}

export function frameHeader({
  opcode,
  isFinal = true,
  mask,
  payloadSize = 0,
  compressionBit = false // only set on first fragment
}) {
  let headerSize = 2, offset = 0, payloadSize7bit
  if (payloadSize > 0xFFFF) { // 64 bit extended payload length
    payloadSize7bit = 127
    headerSize += 8
  } else if (payloadSize > 125) { // 16 bit extended payload length
    payloadSize7bit = 126
    headerSize += 2
  } else { // 7 bit payload length
    payloadSize7bit = payloadSize
  }
  if (mask != undefined) headerSize += 4
  const buffer = Buffer.allocUnsafe(headerSize)
  const bitField = 
    isFinal << 15 | 
    compressionBit << 14 | // rsv1
    opcode << 8 |
    (mask != undefined ? 1 : 0) << 7 |
    payloadSize7bit
  buffer.writeUInt16BE(bitField, offset); offset += 2
  switch (payloadSize7bit) {
    case 127: buffer.writeBigInt64BE(BigInt(payloadSize), offset); offset += 8; break
    case 126: buffer.writeUInt16BE(payloadSize, offset); offset += 2; break
  }
  if (mask != undefined) buffer.writeUInt32BE(mask, offset)
  return buffer
}
