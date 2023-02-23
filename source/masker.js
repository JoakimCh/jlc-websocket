
import * as crypto from 'node:crypto'
import {uint32swap} from "./div.js"

export class Masker {
  #maskByte; #maskUint32 = new Array(4)
  #offset

  /** Set a new mask from a `Buffer` or `Number` (32bit B.E.). Or `undefined` to create a new random mask. It also returns the new mask as an unsigned 32-bit B.E. integer. */
  newMask(mask = crypto.randomBytes(4)) {
    this.#offset = 0
    let maskUint32, result
    if (mask instanceof Buffer) {
      result = mask.readUInt32BE()
      maskUint32 = mask.readUInt32LE() // since Uint32Array is LE
    } else if (typeof mask == 'number') {
      result = mask
      maskUint32 = uint32swap(mask) // since Uint32Array is LE
      mask = [ // buffer mask bytes
        maskUint32        & 0xFF,
        maskUint32 >>   8 & 0xFF,
        maskUint32 >>  16 & 0xFF,
        maskUint32 >>> 24
      ]
    } else throw Error('Invalid mask.')
    this.#maskByte = mask
    // buffer different offsets
    this.#maskUint32[0] = maskUint32
    this.#maskUint32[1] = (maskUint32 >>>  8 | maskUint32 << 24) >>> 0
    this.#maskUint32[2] = (maskUint32 >>> 16 | maskUint32 << 16) >>> 0
    this.#maskUint32[3] = (maskUint32 >>> 24 | maskUint32 <<  8) >>> 0
    return result
  }

  maskInPlace(buffer) {
    if (this.#maskUint32 == 0) return
    const {byteOffset, length} = buffer
    let i = 0
    if (byteOffset % 4 == 0 && length >= 4) {
      // mask with 32 bits as far as possible (for performance)
      const leftover = length % 4 // if bytes at end doesn't fit in 32 bits?
      const maskUint32 = this.#maskUint32[this.#offset]
      const uint32Array = new Uint32Array(buffer.buffer, byteOffset, (length - leftover) / 4)
      for (; i<uint32Array.length; i++) {
        uint32Array[i] = uint32Array[i] ^ maskUint32 >>> 0
      }
      if (!leftover) return // any leftover bytes are dealt with below
      i *= 4
    }
    // apply mask byte by byte
    for (; i<length; i++) {
      buffer[i] = buffer[i] ^ this.#maskByte[this.#offset]
      if (++this.#offset == 4) this.#offset = 0
    }
    return buffer
  }
}
