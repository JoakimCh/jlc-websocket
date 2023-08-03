
import * as stream from 'node:stream'

export function uint32swap(value) {
  return (
    ((value & 0xFF000000) >>> 24) |
    ((value & 0x00FF0000) >>   8) |
    ((value & 0x0000FF00) <<   8) |
    ((value & 0x000000FF) <<  24)
  ) >>> 0
}

/** If a writable stream has `writableNeedDrain` set then use this to wait for the `drain` event or reject on an error. */
export function drainPromise(stream) {
  // debug('# drainPromise used #')
  return new Promise((resolve, reject) => {
    stream.once('error', reject)
    stream.once('drain', () => {
      stream.off('error', reject) // remove it then
      resolve()
      // debug('# drainPromise resolved #')
    })
  })
}

export class Mutex {
  #lock; #keys = []

  /** Return a promise which will resolve when the current lock (if any) is unlocked. It will then lock the mutex again and the resolved promise will contain a key which can be used to unlock it. If used with a timeout and it timed out then the key will already have unlocked it and the property `key.timedOut` will be set to true. */
  async lock(timeout = 0, allowMultipleUnlockCalls = false) {
    const waitFor = this.#lock
    let ourLockResolve
    const ourLock = new Promise(resolve => ourLockResolve = resolve)
    this.#lock = ourLock
    const key = {
      lock: ourLock, // the lock bound to this key
      unlocked: false, // state of lock
      timedOut: false,
      /** Unlock the mutex. */
      unlock: () => {
        if (key.unlocked) {
          if (!allowMultipleUnlockCalls) throw Error('Already unlocked.')
          return
        }
        key.unlocked = true
        this.#keys.shift()
        if (this.#keys.length == 0) { // last lock
          this.#lock = undefined
        }
        ourLockResolve()
      }
    }
    this.#keys.push(key)
    if (timeout) {
      let timeoutPromise, timeoutResolve, timeoutTimer // so we can cancel them
      timeoutPromise = new Promise(resolve => timeoutResolve = resolve)
      timeoutTimer = setTimeout(() => {
        if (!key.unlocked) {
          key.timedOut = true
          key.unlock() // cancel our lock then
          key.unlock = () => {throw Error('Tried to unlock a lock that timed out and is therefore already unlocked. Next time check the key.timedOut property to check if you got a lock or timed out waiting for one.')}
        }
        timeoutResolve(true)
      }, timeout)
      await Promise.race(timeoutPromise, waitFor)
      if (key.timedOut == false) {
        // do not leave anything "hanging"
        clearTimeout(timeoutTimer)
        timeoutResolve()
      }
    } else {
      await waitFor
    }
    return key
  }
  
  /** Returns the key to the current lock or `undefined` if none. */
  get key() {return this.#keys[0]}

  /** Returns a promise which waits for the current lock to be unlocked. */
  get lockPromise() {return this.#keys[0]?.lock || Promise.resolve()}

  /** Returns the number of pending unlocks. */
  get locked() {return this.#keys.length}

  /** Returns a promise which waits for any pending locks to be finished. Basically it will resolve at the end of all the queded work protected by locks. But if you lock again after this has resolved, then that's on you... */
  get allUnlockedPromise() {
    return new Promise(async resolve => {
      while (this.#lock) {await this.#lock}
      resolve()
    })
  }
}

export class WebSocketError extends Error {
  constructor(code = 'GENERIC_ERROR', message = 'Error', options) {
    super(message, options)
    this.reason = message
    this.code = code
  }
}

/** For piping a `Buffer` into a stream. Unlike `stream.Readable.from(buffer)` (which always pass the whole buffer in ONE chunk) it chunks the buffer in pieces according to highWaterMark. */
export class BufferStream extends stream.Readable {
  #buffer; #offset = 0

  constructor(buffer, {highWaterMark} = {}) {
    super({highWaterMark})
    this.#buffer = buffer
  }

  _read(preferedSize) { // usually matches highWaterMark
    const chunk = this.#buffer.subarray(this.#offset, this.#offset + preferedSize)
    this.#offset += chunk.length
    chunk.isLast = this.#offset == this.#buffer.length
    this.push(chunk)
    if (chunk.isLast) this.push(null)
  }
}

export function deepFreeze(object) {
  for (const key in object) {
    if (!Object.isFrozen(object[key])) deepFreeze(object[key])
  }
  return Object.freeze(object)
}

/** A class for creating a trigger with an optional amount of switches that resolves a promise when triggered. */
export class Trigger {
  #promise; #resolve; #reject
  #switches; #switched; #numSwitched = 0
  #throwOnSurplus 
  /**
   * @param {number|Array.<string>} [switches=1] How many switches must be switched before it triggers, either a `number` or an `array` of switch titles. Defaults to `1`.
   * @param {boolean} [throwOnSurplus=true] If switching a switch more than needed should throw an error.
   */
  constructor(switches = 1, throwOnSurplus = true) {
    this.#throwOnSurplus = throwOnSurplus
    if (typeof switches == 'number') {
      this.#switches = switches
      this.#switched = []
    } else if (!Array.isArray(switches)) {
      this.#switches = new Set(switches)
      this.#switched = {}
    } else throw Error('"switches" must be a number or an array of switch titles.')
    this.#promise = new Promise((resolve, reject) => {
      this.#resolve = resolve
      this.#reject = reject
    })
  }

  /** The promise which is resolved when triggered. If values were used with the switches they will be returned here, either as an object (if named switches) or as an array. */
  get promise() {return this.#promise}

  /** If you want to reject the trigger promise with an error. */
  reject(error) {this.#reject(error)}

  /**
   * A trigger may have several switches to be switched before it will trigger. Either using named switches or a certain number of switches.
   * @param {string|undefined} [switchTitle=null] If using named switches then enter the name here, else leave `null` or `undefined`.
   * @param {*} [value=null] The optional value related to the switch.
   */
  switch(switchTitle = null, value = null) {
    if (typeof this.#switches == 'number') {
      value = switchTitle
      // if (valueOrSwitchTitle) throw Error('This trigger has no switches defined.')
      if (this.#throwOnSurplus && this.#numSwitched == this.#switches.size) throw Error('Switched more times than needed (not allowed since throwOnSurplus = true).')
      this.#switched.push(value); this.#numSwitched ++
      if (this.#numSwitched == this.#switches) this.#resolve(this.#switched.length == 1 ? this.#switched[0] : this.#switched)
    } else if (switchTitle) {
      if (!this.#switches.has(switchTitle)) throw Error('This trigger has no such switch defined: '+switchTitle)
      if (!(switchTitle in this.#switched)) { // only first value is kept
        this.#switched[switchTitle] = value; this.#numSwitched ++
      } else if (this.#throwOnSurplus) throw Error('Switched twice (not allowed since throwOnSurplus = true): '+switchTitle)
      if (this.#numSwitched == this.#switches.size) this.#resolve(this.#switched)
    }
  }
}
