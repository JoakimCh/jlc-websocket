
import {Transform, PassThrough} from 'node:stream'
import {Blob} from 'node:buffer'
import {Masker} from './masker.js'
import {drainPromise, WebSocketError} from './div.js'
import {Opcode, ZZZZFFFF, validServerCodes, validClientCodes} from './protocolRelated.js'
import * as zlib from 'node:zlib'

const emptyBuffer = Buffer.alloc(0)

export class ProtocolReader extends Transform {
  //#region properties
  #chunks = [] // buffered chunks
  #buffered = 0 // size of all chunks minus bytes read in chunk 0
  #chunkOffset = 0 // bytes read in chunk 0
  #scratch = Buffer.allocUnsafe(8) // a buffer used for reading values inbetween chunks
  #masker = new Masker()
  #inflater; #inflatedChunks = []
  #frame // current frame details
  #msgOpcode // message type, text or binary
  #msgPayload
  #msgTextDecoder
  #msgFragmented // if current message is fragmented
  #msgCompressed // if current message is compressed
  #isClient; #isServer
  #readNext = {
    nothing: 0, // e.g. if errored
    header1: 1,
    header2: 2,
    payload: 3
  }
  #next = this.#readNext.header1 // which part to read next
  #nextSize = 2 // num bytes needed to read it
  #emitFragments
  #utf8failFast
  #compression // compression config
  #messageStream // next message is piped into it
  #messageStreamQueue = [] // streams in queue
  #messageStreamTrigger
  // #config
  #messageHandler; #pingHandler; #pongHandler; #closeHandler
  #binaryType
  #keepSlidingWindow
  checkCloseCode = true
  //#endregion

  constructor({
    options,
    config,
    isClient,
    binaryType,
    messageHandler, pingHandler, pongHandler, closeHandler
  }) {
    super(options)
    // this.#config = config
    this.#binaryType = binaryType
    this.#messageHandler = messageHandler
    this.#pingHandler = pingHandler
    this.#pongHandler = pongHandler
    this.#closeHandler = closeHandler
    this.#isClient = !!isClient
    this.#isServer = !isClient
    this.#emitFragments = config.receiveFragmentedMessages
    this.#utf8failFast = config.utf8failFast
    this.#compression = config.compression
    if (this.#compression) {
      this.#keepSlidingWindow = this.isClient ? this.#compression.serverKeepSlidingWindow : this.#compression.clientKeepSlidingWindow
      this.#inflater = zlib.createInflateRaw({
        windowBits: isClient ? this.#compression.serverMaxWindowBits : this.#compression.clientMaxWindowBits
      })
      this.#inflater.on('data', chunk => this.#inflatedChunks.push(chunk))
      this.#inflater.on('error', error => this.#error(1002, 'Decompression error: '+error))
    }
  }

  #handlePingFrame() {
    this.#pingHandler(this.#getControlFramePayload())
  }

  #handlePongFrame() {
    this.#pongHandler(this.#getControlFramePayload())
  }

  #handleCloseFrame() {
    const payload = this.#getControlFramePayload()
    let code = 1005, reason
    if (payload?.length >= 2) {
      code = payload.readUInt16BE(0)
      if (payload.length > 2 && payload.length <= 125) {
        try {
          reason = new TextDecoder('utf-8', {fatal: true}).decode(payload.subarray(2))
        } catch {
          return this.#error(1007, 'Invalid UTF-8 encoded text.')
        }
      }
      if (this.checkCloseCode) {
        if (this.#isServer) {
          if (!(validClientCodes.includes(code) || (code >= 3000 && code <= 4999))) {
            return this.#error(1002, 'Client closed the connection with an invalid code: '+code)
          }
        } else {
          if (!(validServerCodes.includes(code) || (code >= 3000 && code <= 4999))) {
            return this.#error(1002, 'Server closed the connection with an invalid code: '+code)
          }
        }
      }
    } else if (payload?.length == 1) {
      return this.#error(1002, 'Invalid close frame.')
    }
    this.#closeHandler(code, reason) // if no errors
  }

  /** Protocol error. */
  #error(code, reason) {
    if (this.destroyed) return
    this.destroy({code, reason})
    return true
  }
  
  _destroy(error, callback) {
    this.#next = this.#readNext.nothing
    this.#nextSize = Infinity
    callback(error)
  }

  async _transform(chunk, _encoding, callback) {
    if (chunk.length) { // ignore any empty buffers
      this.#chunks.push(chunk)
      this.#buffered += chunk.length
    }
    // Any #error()'s will result in: 
    // this.#next = this.#readNext.nothing
    // this.#nextSize = Infinity
    while (this.#buffered >= this.#nextSize && !this.destroyed) {
      if (this.#next == this.#readNext.header1 && this.#buffered >= this.#nextSize) {
        this.#read16bitHeader()
      }
      if (this.#next == this.#readNext.header2 && this.#buffered >= this.#nextSize) {
        this.#readRestOfHeader()
      }
      if (this.#next == this.#readNext.payload && this.#buffered >= this.#nextSize) {
        if (this.#chunkOffset) this.#trimCurrentChunk()
        let chunk
        while (chunk = this.#chunks.shift()) {
          if (this.destroyed) break
          if (this.#frame.payloadConsumed + chunk.length <= this.#frame.payloadSize) {
            this.#buffered -= chunk.length
            if (await this.#consumePayloadChunk(chunk)) return
          } else { // if chunk contains more than the payload
            const payloadSizeLeft = this.#frame.payloadSize - this.#frame.payloadConsumed
            this.#buffered -= payloadSizeLeft
            if (await this.#consumePayloadChunk(chunk.subarray(0, payloadSizeLeft))) return
            const leftover = chunk.subarray(payloadSizeLeft)
            this.#chunks.unshift(leftover) // put it back
            this.#chunkOffset = 0
          }
          if (this.#frame.payloadConsumed == this.#frame.payloadSize) break
        }
      }
    }
    callback() // we're ready for the next chunk
  }

  #emitMessage() {
    let data = this.#emitFragments ? this.#frame.payload : this.#msgPayload
    if (this.#msgOpcode == Opcode.binary) {
      data = data.length > 1 ? Buffer.concat(data) : data[0] || emptyBuffer
      switch (this.#binaryType) {
        case 'blob': data = new Blob([data]); break
        case 'arraybuffer': {
          const {buffer, byteOffset, length} = data
          if (buffer.byteLength == length) { // correct size
            data = buffer
          } else { // views only a window
            data = buffer.slice(byteOffset, byteOffset + length) // creates a new ArrayBuffer with this data view copied into it
          }
        }
      }
    } else if (!this.#utf8failFast) {
      try {
        const decoder = new TextDecoder('utf-8', {fatal: true})
        data = decoder.decode(data.length > 1 ? Buffer.concat(data) : data[0])
      } catch (error) {
        return this.#error(1007, 'Invalid UTF-8 encoded text.')
      }
    }
    this.#messageHandler(data, this.#frame.isFinal)
    if (this.#frame.isFinal) { // clean-up
      this.#msgFragmented = false
      this.#msgCompressed = false
      this.#msgOpcode = null
      this.#msgPayload = null
      this.#msgTextDecoder = null
    }
  }

  /** Handle the frame header. */
  #handleHeader() {
    const {isFinal, opcode, hasMask, mask, payloadSize7bit, payloadSize, rsvBit1, rsvBit2, rsvBit3} = this.#frame
    this.#frame.payloadConsumed = 0 // add this
    this.#frame.isControlFrame = Boolean(opcode >> 3 & 1) // if a control frame (ping, pong, close)
    let compressed, illegalUseOfReservedBits
    if (this.#compression) {
      if (rsvBit1) compressed = true
      if (rsvBit2 || rsvBit3) illegalUseOfReservedBits = true
    } else if (rsvBit1 || rsvBit2 || rsvBit3) {
      illegalUseOfReservedBits = true
    }
    if (illegalUseOfReservedBits) return this.#error(1002, 'Illegal use of the reserved bits.')
    if (this.#frame.isControlFrame) { 
      if (payloadSize7bit > 125 || !isFinal) return this.#error(1002, 'All control frames MUST have a payload length of 125 bytes or less and MUST NOT be fragmented.')
      if (compressed) return this.#error(1002, 'The compressed bit was set in a control frame.')
      this.#frame.payload = []
    }
    if (this.#isClient) {
      if (hasMask) return this.#error(1002, 'A server MUST NOT mask any frames that it sends to the client.')
    } else if (payloadSize && !hasMask) {
      return this.#error(1002, 'A client MUST mask any payloads that it sends to the server.')
    }
    if (hasMask) this.#masker.newMask(mask)
    // debug('isClient', this.#isClient, this.#frame)
    switch (opcode) {
      default: return this.#error(1002, 'Invalid WebSocket opcode: '+opcode)
      case Opcode.ping: if (!payloadSize) this.#handlePingFrame(); break
      case Opcode.pong: if (!payloadSize) this.#handlePongFrame(); break
      case Opcode.close: if (!payloadSize) this.#handleCloseFrame(); break
      case Opcode.continuation:
        if (!this.#msgFragmented) return this.#error(1002, 'Received a continuation frame outside of any fragmented messages.')
        if (this.#emitFragments && !this.#messageStream) this.#frame.payload = this.#msgOpcode == Opcode.text ? '' : []
        if (payloadSize == 0 && isFinal) {
          this.#consumePayloadChunk(emptyBuffer)
          // this.#emitMessage()
        }
      break
      case Opcode.binary: case Opcode.text: // new message
        if (this.#msgFragmented) return this.#error(1002, 'Tried to send a new message before finishing a fragmented one.')
        this.#msgOpcode = opcode
        this.#msgFragmented = !isFinal
        this.#msgCompressed = compressed
        if (this.#messageStreamQueue.length) {
          this.#messageStream = this.#messageStreamQueue.shift()
        }
        if (!this.#messageStream) {
          if (opcode == Opcode.text && this.#utf8failFast) {
            this.#msgTextDecoder = new TextDecoder('utf-8', {fatal: true})
            if (!this.#emitFragments) this.#msgPayload = ''
            else this.#frame.payload = ''
          } else {
            if (!this.#emitFragments) this.#msgPayload = []
            else this.#frame.payload = []
          }
        } else {
          this.pipe(this.#messageStream.stream, {end: false}) // we end it manually
        }
        if (payloadSize == 0 && isFinal) this.#emitMessage()
    }
  }

  /** Creates a reduced view of `#chunks[0]` according to `#chunkOffset` and of course sets `#chunkOffset` back to 0. */
  #trimCurrentChunk() {
    // if (this.#chunkOffset == 0) return
    this.#chunks[0] = this.#chunks[0].subarray(this.#chunkOffset)
    this.#chunkOffset = 0
  }

  /** Fill a scratch buffer with X bytes from two or more chunks. Only to be used when chunks[0] doesn't have enough bytes. */
  #fillScratch(bytesWanted) {
    this.#buffered -= bytesWanted
    if (bytesWanted <= 8) { // read up to 8 bytes into our scratch buffer
      for (let offset=0; offset<bytesWanted; offset++) {
        this.#scratch[offset] = this.#chunks[0][this.#chunkOffset++]
        if (this.#chunkOffset == this.#chunks[0].length) {
          this.#chunks.shift(); this.#chunkOffset = 0
        }
      }
      return this.#scratch
    } else { // concat data from chunks into a new buffer (will copy)
      if (this.#chunkOffset) this.#trimCurrentChunk()
      const buffer = Buffer.concat(this.#chunks, bytesWanted)
      // the code below removes concatenated chunks and corrects #chunkOffset
      let bytesFound = 0, chunksToRemove = 0
      do {
        bytesFound += this.#chunks[chunksToRemove++].length
      } while(bytesFound < bytesWanted)
      if (bytesFound != bytesWanted) {
        this.#chunkOffset = this.#chunks[--chunksToRemove].length - (bytesFound - bytesWanted)
      } else {
        this.#chunkOffset = 0
      }
      this.#chunks.splice(0, chunksToRemove)
      return buffer
    }
  }

  /** Returns a `Buffer` with `bytesWanted` available and the offset to read from. Will concatenate (merge chunks into a new Buffer) only if needed. */
  #read(bytesWanted) {
    if (bytesWanted > this.#buffered) throw Error('Should not happen.')
    if (bytesWanted > this.#chunks[0].length - this.#chunkOffset) { // chunk have some bytes, but not enough
      return [this.#fillScratch(bytesWanted), 0] // then chunks needs to be combined in a "scratch buffer"
    } else {
      const result = [this.#chunks[0], this.#chunkOffset]
      this.#buffered    -= bytesWanted
      this.#chunkOffset += bytesWanted
      if (this.#chunkOffset == this.#chunks[0].length) {
        this.#chunks.shift(); this.#chunkOffset = 0
      }
      return result
    }
  }

  #read16bitHeader() {
    const [buffer, offset] = this.#read(2)
    const first16headerBits = buffer.readUInt16BE(offset)
    this.#frame = {
      isFinal: first16headerBits >> 15,
      rsvBit1: first16headerBits >> 14 & 0b1,
      rsvBit2: first16headerBits >> 13 & 0b1,
      rsvBit3: first16headerBits >> 12 & 0b1,
      opcode:  first16headerBits >>  8 & 0b1111,
      hasMask: first16headerBits >>  7 & 0b1,
      payloadSize7bit: first16headerBits & 0b111_1111,
    }
    this.#frame.payload = null
    this.#frame.payloadSize = 0
    this.#frame.payloadConsumed = 0
    const {payloadSize7bit, hasMask} = this.#frame
    this.#frame.payloadSize = 0 // reset
    let header2Size = 0 // will there be one?
    if (payloadSize7bit == 127) { // 64 bit payload size
      header2Size += 8
    } else if (payloadSize7bit == 126) { // 16 bit payload size
      header2Size += 2
    } else {
      this.#frame.payloadSize = payloadSize7bit
    }
    if (hasMask) header2Size += 4
    if (header2Size) {
      this.#next = this.#readNext.header2
      this.#nextSize = header2Size
    } else if (this.#frame.payloadSize) {
      this.#next = this.#readNext.payload
      this.#nextSize = 1 // (as in 1 or larger)
    } else {
      this.#next = this.#readNext.header1
      this.#nextSize = 2
    }
    if (!header2Size) this.#handleHeader()
  }

  #readRestOfHeader() {
    let [buffer, offset] = this.#read(this.#nextSize)
    const {payloadSize7bit, hasMask} = this.#frame
    if (payloadSize7bit == 127) { // 64 bit payload size
      const bigIntPayloadSize = buffer.readBigUInt64BE(offset); offset += 8
      if ((bigIntPayloadSize >> 64n) & 1n) return this.#error(1002, 'WebSocket 64bit payload size has MSB set (which should not happen).')
      if (bigIntPayloadSize > BigInt(Number.MAX_SAFE_INTEGER)) return this.#error(1009, 'WebSocket payload size is larger than Number.MAX_SAFE_INTEGER (which is ridiculus, hence this library don\'t support it).')
      this.#frame.payloadSize = Number(bigIntPayloadSize)
    } else if (payloadSize7bit == 126) { // 16 bit payload size
      this.#frame.payloadSize = buffer.readUInt16BE(offset); offset += 2
    }
    if (hasMask) this.#frame.mask = buffer.readUInt32BE(offset)
    if (this.#frame.payloadSize) {
      this.#next = this.#readNext.payload
      this.#nextSize = 1 // (as in 1 or larger)
    } else {
      this.#next = this.#readNext.header1
      this.#nextSize = 2
    }
    this.#handleHeader()
  }

  #getControlFramePayload() {
    if (this.#frame.payloadSize) {
      const payload = this.#frame.payload
      return payload.length > 1 ? Buffer.concat(payload) : payload[0]
    }
  }

  #decompressChunk(chunk, finalChunkOfFrame, finalChunkOfMsg) {
    // debug(chunk.length, {finalChunkOfFrame})
    return new Promise(async (resolve, reject) => {
      if (this.#inflater.writableNeedDrain) await drainPromise(this.#inflater)
      // debug(chunk.length, chunk.subarray(0,4), chunk.subarray(-4))
      this.#inflater.write(chunk, error => {
        if (error) reject(error)
        else if (!finalChunkOfFrame) resolve()
      })
      if (finalChunkOfMsg) { // then add ZZZZFFFF
        if (this.#inflater.writableNeedDrain) await drainPromise(this.#inflater)
        this.#inflater.write(ZZZZFFFF, error => {if (error) reject(error)})
        // debug('ZZZZFFFF')
      }
      if (finalChunkOfFrame) { // then flush
        this.#inflater.flush(finalChunkOfMsg && !this.#keepSlidingWindow ? zlib.constants.Z_FULL_FLUSH : zlib.constants.Z_SYNC_FLUSH, error => {
          if (error) return reject(error)
          if (!this.#inflatedChunks.length) {
            // debug('What the fuck?')
            // setTimeout(() => {
            //   debug(this.#inflatedChunks)
            // }, 200)
            // throw Error('No way?')
            this.#inflatedChunks.push(emptyBuffer)
          }
          resolve()
        })
      }
    })
    // inflater has on data handler that writes to #inflatedChunks
  }

  async #consumePayloadChunk(chunk) {
    this.#frame.payloadConsumed += chunk.length
    const finalChunkOfFrame = this.#frame.payloadConsumed == this.#frame.payloadSize
    // debug(this.#frame.payloadSize, this.#frame.payloadConsumed, this.#frame.isFinal)
    const finalChunkOfMsg = this.#frame.isFinal && finalChunkOfFrame
    if (finalChunkOfFrame) {
      this.#next = this.#readNext.header1
      this.#nextSize = 2
    }
    // debug('payload chunk', this.#frame, finalChunkOfFrame)
    if (this.#isServer) this.#masker.maskInPlace(chunk)
    if (this.#msgCompressed) {
      try {
        await this.#decompressChunk(chunk, finalChunkOfFrame, finalChunkOfMsg)
      } catch (error) {
        debug('decompressChunk error', error)
        return this.#error(1002, 'Decompression error: '+error)
      }
      if (!this.#inflatedChunks.length) return
      chunk = this.#inflatedChunks.length > 1 ? Buffer.concat(this.#inflatedChunks) : this.#inflatedChunks[0]
      this.#inflatedChunks.length = 0
      // debug(chunk)
    }
    switch (this.#frame.opcode) {
      default: this.#frame.payload.push(chunk); break
      case Opcode.binary: case Opcode.text: case Opcode.continuation:
        if (this.#consumeMessagePayloadChunk(chunk)) return
        // if (this.destroyed) return
    }
    if (finalChunkOfFrame && this.#frame.isControlFrame) {
      switch (this.#frame.opcode) {
        case Opcode.ping: this.#handlePingFrame(); break
        case Opcode.pong: this.#handlePongFrame(); break
        case Opcode.close: this.#handleCloseFrame(); break
      }
    }
  }

  #consumeMessagePayloadChunk(chunk) {
    const finalChunk = this.#frame.payloadConsumed == this.#frame.payloadSize
    if (this.#messageStream) { // if piped into a stream to be consumed by end user
      if (chunk.length) this.push(chunk) // since we're a transform stream we don't need to check the return value
      // #messageStream is responsible for UTF-8 decoding if needed and to close if errors
      if (finalChunk && this.#frame.isFinal) this.#endMessageStream()
      return
    }
    // #### If receiving payload in full or fragments ####
    if (this.#msgOpcode == Opcode.text && this.#utf8failFast) {
      try {
        const text = this.#msgTextDecoder.decode(chunk, {stream: !(this.#frame.isFinal && finalChunk)})
        if (this.#emitFragments) this.#frame.payload += text
        else this.#msgPayload += text
      } catch (error) {
        return this.#error(1007, 'Invalid UTF-8 encoded text.')
      }
    } else { // binary message or buffered text
      if (this.#emitFragments) this.#frame.payload.push(chunk)
      else this.#msgPayload.push(chunk)
    }
    if (!finalChunk) return
    // final chunk of frame received
    if (this.#frame.isFinal || this.#emitFragments) this.#emitMessage()
  }

  #endMessageStream() {
    const {stream, callback} = this.#messageStream
    this.unpipe(stream); stream.end()
    callback?.(stream) // guaranteed to be fast enough to set a new #messageStream before the next message is received
    this.#messageStream = null
    this.#msgOpcode = null
    this.#msgFragmented = null
    this.#msgCompressed = null
  }

  receiveStream(stream, callback) {
    if (callback && typeof callback != 'function') throw new WebSocketError('TYPE_ERROR', 'receiveStream callback must be a function or undefined')
    if (!stream) stream = new PassThrough({highWaterMark: this.readableHighWaterMark})
    this.#messageStreamQueue.push({stream, callback})
    return stream
  }
}
