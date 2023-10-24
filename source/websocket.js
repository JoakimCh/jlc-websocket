
import {EventEmitter} from 'node:events'
import {ProtocolReader} from './protocolReader.js'
import {ProtocolWriter} from './protocolWriter.js'
import {WebSocketError, deepFreeze, Mutex} from './div.js'
import {closeCodeExplanation} from './protocolRelated.js'

function makeInstanceGettersEnumerable(object) { // from: https://stackoverflow.com/a/57179513/4216153
  const prototype = Object.getPrototypeOf(object)
  const prototype_property_descriptors = Object.getOwnPropertyDescriptors(prototype)
  for (const [property, descriptor] of Object.entries(prototype_property_descriptors)) {
    const is_nonstatic_getter = typeof descriptor.get == 'function'
    if (is_nonstatic_getter) {
      descriptor.enumerable = true
      Object.defineProperty(object, property, descriptor)
    }
  }
}

export class WebSocket extends EventEmitter {
  //#region properties/getters/setters
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  #readyState = WebSocket.CONNECTING; #binaryType = 'nodebuffer'; #url = null; #protocol = null; #extensions = null
  #ioStream; #protocolWriter; #protocolReader; #isClient; #isServer
  config = {} // will be locked
  #defaultConfig = {
    httpHeaders: {}, // any custom http headers to send with the request (client) or response (server)
    // compression: false,
    compression: { // true/false or config
      // interesting discussion: https://github.com/websockets/ws/issues/1369
      thresholdNoContext: 1024, // do not compress messages less than this size
      thresholdWithContext: 128,
      // useSyncZlib: false, // (server might not want to) use _processChunk(), see: https://github.com/nodejs/node/blob/main/lib/zlib.js#L427
      clientMaxWindowBits: 15, // 2**15 == 32K
      serverMaxWindowBits: 15,
      clientKeepSlidingWindow: true,
      serverKeepSlidingWindow: true
    },
    // minFragmentSize: 1024 * 16,
    maxFragmentSize: 1024 * 16, // split messages into fragments up to this size if the message is larger
    maxMessageSize: false, // max size of message to receive, fails the connection if needed (todo)
    utf8failFast: false, // whether to decode incoming UTF-8 data when received (slow) or wait until all is received (fast)
    zeroMasking: true, // whether the client should use a mask of 0x00000000 and in effect skip applying it (best performance, but legacy servers might have an issue with this)
    // outgoingHighWaterMark: 1024 * 16,
    incomingHighWaterMark: 1024 * 32, // for incoming protocol data
    receiveFragmentedMessages: false,
    timeout: 2000, // connection timeout when connecting
    forcedTerminationTimeout: 2000, // max amount of time to wait for a closing negotiation before terminating the connection
    pingInterval: 4000, // if no traffic for this amount of ms then send a ping (server side)
    pongTimeout: 1000, // if no pong received within this time after a ping then fail the connection
    allowRedirections: true, // endpoint redirections
    maxRedirections: 10,
    // automaticReconnect: { // true/false or config
    //   failedAttemptDelay: 2000,
    //   maxAttempts: 10,
    //   progressiveDelay: 500,
    //   maxDelay: 10_000,
    //   retryAtInternetReturn: true
    // }
  }
  #pingMutex = new Mutex() // unlocks when pong is received or times out
  #closeCalled; #closeFrameSent; #closeFrameReceived; #closeCode; #closeReason
  #forcedTerminationTimeout
  /** Whether to send and receive messages as JSON. Buffer, ArrayBuffer, TypedArray, DataView or Blob will still be sent and received as binary messages though (where binaryType represent their type then). */
  jsonMode

  get isClient() {return this.#isClient}
  get isServer() {return this.#isServer}
  get socket() {return this.#ioStream || null}
  set binaryType(value) {
    value = value.toLowerCase()
    switch (value) {
      default: throw new WebSocketError('INVALID_BINARYTYPE', 'binaryType not supported: '+value)
      case 'blob': case 'arraybuffer': case 'nodebuffer':
    }
    this.#binaryType = value
    if (this.#protocolReader) this.#protocolReader.binaryType = this.#binaryType
  }
  set jsonMode(on) {
    this.jsonMode = on
    if (this.#protocolReader) this.#protocolReader.jsonMode = this.jsonMode
    if (this.#protocolWriter) this.#protocolWriter.jsonMode = this.jsonMode
  }
  get readyStateAsString() {
    switch (this.#readyState) {
      case WebSocket.CONNECTING: return 'connecting'
      case WebSocket.OPEN: return 'open'
      case WebSocket.CLOSING: return 'closing'
      case WebSocket.CLOSED: return 'closed'
    }
  }
  // Standard Properties
  get binaryType() {return this.#binaryType}
  get bufferedAmount() {return this.#protocolWriter?.bufferedAmount}
  get extensions() {return this.#extensions}
  get protocol() {return this.#protocol}
  get readyState() {return this.#readyState}
  get url() {return this.#url}
  // End of Standard Properties
  // Some basic level of compatibility with the browser event API:
  set onopen(listener) {this.#onListener('open', listener)}
  set onclose(listener) {this.#onListener('close', listener)}
  set onmessage(listener) {this.#onListener('message', listener)}
  set onerror(listener) {this.#onListener('error', listener)}
  #on = {}
  #onListener(event, listener) {
    if (this.#on[event]) {
      this.off(event, this.#on[event])
      this.#on[event] = null
    }
    this.on(event, listener)
    this.#on[event] = listener
  }
  //#endregion

  /**
   * @param {string} url The WebSocket server endpoint to connect to.
   */
  constructor() {
    super()
    makeInstanceGettersEnumerable(this)
    Object.defineProperty(this, '_events', {enumerable: false})
    Object.defineProperty(this, '_eventsCount', {enumerable: false})
    Object.defineProperty(this, '_maxListeners', {enumerable: false})
    Object.seal(this) // this is useful to prevent mistakes
    const {url, protocols, config, request} = this.#handleArguments(arguments)
    this.config = {
      ...this.#defaultConfig,
      ...config
    }
    this.config.compression = {
      ...this.#defaultConfig.compression,
      ...config.compression
    }
    // this.config.automaticReconnect = {
    //   ...this.#defaultConfig.automaticReconnect,
    //   ...config.automaticReconnect
    // }
    this.#configSanityCheck()
    if (url) {
      this.#isClient = true; this.#isServer = false
      this.#connectToServer(url, protocols) // async
    } else {
      this.#isServer = true; this.#isClient = false
      this.#handleWebSocketUpgrade(request, protocols) // async
    }
  }

  // protect other code from invalid config
  #configSanityCheck() {
    function invalidRange(value, min, max) {return (value < min || value > max)}
    const config = this.config
    if (config.compression) {
      const {clientMaxWindowBits, serverMaxWindowBits} = config.compression
      if (invalidRange(clientMaxWindowBits, 8, 15)) throw Error('Invalid range for clientMaxWindowBits.')
      if (invalidRange(serverMaxWindowBits, 8, 15)) throw Error('Invalid range for serverMaxWindowBits.')
    }
    if (config.receiveFragmentedMessages && !config.liveTextDecode) throw Error('Can\'t not do "liveTextDecode" if "receiveFragmentedMessages".')
  }

  addEventListener(event, listener, options = {}) {
    if (options.once) {
      this.once(event, listener)
    } else {
      this.on(event, listener)
    }
  }

  removeEventListener(event, listener) {
    this.off(event, listener)
  }

  /**
   * Send a message, either as a string or binary data.
   * @param {(Buffer|string|ArrayBuffer|ArrayBufferView|Blob)} data The data or string to be sent, even empty messages are allowed.
   * @param {boolean} [allowCompression = true] Allow this message to be compressed (if compression is enabled). It's `true` by default, hence set it to `false` when you want to keep the data from being compressed, e.g. if it's already compressed.
   * @returns Returns a `Promise` which will resolve when the message has been consumed by the underlying stream. Messages sent before it resolves are buffered and sent in order.
   */
  send(data, allowCompression = true) {
    if (this.#readyState == WebSocket.CONNECTING) throw new WebSocketError('SEND_WHILE_CONNECTING', 'You must wait for the "open" event to be emitted before sending messages.')
    return this.#protocolWriter.send(data, allowCompression)
  }

  /**
   * Gracefully close the connection after any buffered messages are sent. The close code defaults to 1000 (normal closure) but custom codes in the range 3000-4999 are allowed in addition to it. On the server side some additional codes are allowed (defined in RFC 6455).
   * @param {number} [code = 1000] A code used to inform the other side why the connection was closed.
   * @param {string} [reason] Optionally a reason (text).
   * @returns 
   */
  async close(code = 1000, reason) {
    if (this.#readyState == WebSocket.CONNECTING) {
      const onOpen = () => this.close(code, reason)
      this.once('open', onOpen)
      this.once('error', () => this.off(onOpen))
      return
    }
    if (this.#closeCalled) return; this.#closeCalled = true
    this.#readyState = WebSocket.CLOSING
    this.#forcedTerminationTimeout = setTimeout( // if not closed within a reasonable time
      () => {
        this.#ioStream.destroy().unref()
      }, 
      this.config.forcedTerminationTimeout, 
    )
    if (this.#isServer) this.#protocolReader.checkCloseCode = false // client must echo our code, hence allow receiving non-client codes
    this.#closeFrameSent = await this.#protocolWriter.close(code, reason) // true if sent without error
  }

  /**
   * Manually send a ping to the other side with an optional payload. Trying to send more before the returned `Promise` resolves will result in them being queued and sent in order. `.config.pongTimeout` sets the max waiting time before ending the connection with a protocol error if a pong was not received.
   * @param {Buffer} payload A Node.js `Buffer` to send or `undefined` to not send any payload.
   * @returns A promise containing the payload of the next received pong message or `null` if error.
   */
  async ping(payload) {
    if (this.#readyState == WebSocket.CONNECTING) throw new WebSocketError('PING_ERROR', 'You must wait for the "open" event to be emitted before using ping().')
    const {unlock} = await this.#pingMutex.lock() // wait for any other ping to resolve, then the matching pong should always be received
    let result
    if (this.#readyState != WebSocket.OPEN) {
      result = null
    } else {
      await this.#protocolWriter.ping(payload)
      result = await new Promise((resolve) => {
        const doReject = (didTimeout) => {
          this.off('pong', doResolve)
          if (didTimeout) {
            this.off('error', doReject)
            this.#protocolError({code: 1002, reason: 'No response to latest ping.'})
          } else { // protocol error happened
            clearTimeout(pongTimeout) // to not throw another error
          }
          resolve(null) // instead of a rejection
        }
        const doResolve = (payload) => {
          this.off('error', doReject)
          clearTimeout(pongTimeout)
          resolve(payload)
        }
        const pongTimeout = setTimeout(doReject, this.config.pongTimeout, true)
        this.once('error', doReject)
        this.once('pong', doResolve)
      })
    }
    unlock()
    return result
  }

  sendStream(stream, isString) {
    if (this.#readyState == WebSocket.CONNECTING) throw new WebSocketError('SEND_WHILE_CONNECTING', 'You must wait for the "open" event to be emitted before sending messages.')
    return this.#protocolWriter.sendStream(stream, isString)
  }

  /** Pipe the next message into a stream. These calls are queued, e.g. if called two times in a row then the next two messages will be received as streams. 
   * @param {WritableStream} [stream] Optionally a writable stream to pipe the message into. If `undefined` then a new `PassThrough` stream will be created which can be read to get the message data.
   * @param {function} [callback] Optionally a callback to be called when the stream is finished. This can be used to e.g. make a decision based on the streamed data whether the next message should also be received as a stream. Other methods are NOT guaranteed to be fast enough, forget using a `Promise` or the stream "close" event...
   * @returns {WritableStream|PassThrough} Returns the stream.
   */
  receiveStream(stream, callback) {
    if (this.#readyState != WebSocket.OPEN) throw new WebSocketError('ERROR', 'Only call receiveStream on an open connection.')
    return this.#protocolReader.receiveStream(stream, callback)
  }

  /** Detect and verify constructor input arguments.
  client: url, [protocols and/or config]
  server: request, [protocols and/or config] */
  #handleArguments(args) {
    let config = {}, url, protocols, request
    function protocolsAndOrConfig(offset) {
      if (args.length > offset) {
        if (typeof args[offset] == 'string') {
          protocols = [args[offset]]
        } else if (Array.isArray(args[offset])) {
          protocols = args[offset]
        } else if (typeof args[offset] == 'object') {
          config = args[offset]
        } else {
          throw new WebSocketError('INVALID_ARGS', (offset+1)+'. argument is not a protocol string or array of protocol strings, nor a config object.')
        }
        if (args.length > ++offset) {
          if (typeof args[offset] == 'object') {
            config = args[offset]
          }
        }
      }
    }
    if (typeof args[0] == 'string') {
      // client: url, [protocols and/or config]
      url = args[0]
      protocolsAndOrConfig(1)
    } else if (typeof args[0] == 'object' && 'httpVersion' in args[0]) {
      // server: request, socket, [protocols and/or config]
      request = args[0]
      protocolsAndOrConfig(1)
      // if (args.length > 1 && 'remoteAddress' in args[1]) {
      //   socket = args[1]
      //   protocolsAndOrConfig(2)
      // } else {
      //   throw new WebSocketError('INVALID_ARGS', 'Second argument must be the socket from the upgrade event.')
      // }
    } else {
      throw new WebSocketError('INVALID_ARGS', 'First argument is neither a URL or HTTP request.')
    }
    for (const key in config) {
      if (!(key in this.#defaultConfig)) {
        throw new WebSocketError('INVALID_ARGS', 'Invalid key in config object: '+key)
      }
    }
    // if ('automaticReconnect' in config) {
    //   if (typeof config.automaticReconnect == 'object') {
    //     for (const key in config.automaticReconnect) {
    //       if (!(key in this.#defaultConfig.automaticReconnect)) {
    //         throw new WebSocketError('INVALID_ARGS', 'Invalid key in config.automaticReconnect: '+key)
    //       }
    //     }
    //   } else if (typeof config != 'boolean') {
    //     throw new WebSocketError('INVALID_ARGS', 'config.automaticReconnect must be true|false or a configuration object.')
    //   }
    // }
    return {url, protocols, config, request}
  }

  #start({
    url,
    ioStream,
    chunk = null,
    protocol = '',
    extensions = '',
    currentStreamErrorHandler
  }) {
    this.#readyState = WebSocket.OPEN
    this.#url = url
    this.#ioStream = ioStream
    this.#protocol = protocol
    this.#extensions = extensions
    deepFreeze(this.config) // nothing in it can change at runtime

    // ioStream.setNoDelay() // doesn't really help performance
    ioStream.off('error', currentStreamErrorHandler)
    ioStream.on('error', error => {
      if (error.code == 'ECONNRESET') return // autobahn does ECONNRESET instead of TCP-FIN
      switch (this.readyState) {
        case WebSocket.CLOSING: case WebSocket.CLOSED: break
        default:
          this.#protocolReader.destroy({code: 1006, reason: 'Connection failed: '+error}) // which triggers #protocolError
      }
    })
    ioStream.on('end', () => { // is emitted when there is no more data to be consumed from the stream
      ioStream.destroy() // makes sure close is called
    })
    ioStream.on('close', () => {
      clearTimeout(this.#forcedTerminationTimeout)
      this.#readyState = WebSocket.CLOSED
      this.#protocolReader.destroy()
      const code = this.#closeCode || 1006
      this.emit('close', {
        code, reason: this.#closeReason, 
        wasClean: Boolean(this.#closeFrameReceived && this.#closeFrameSent),
        codeExplanation: closeCodeExplanation(code)
      })
    })
    if (this.#isServer) {
      ioStream.setTimeout(this.config.pingInterval) // triggered on no IO-activity within that time
      ioStream.on('timeout', this.ping.bind(this))
    }
    this.#protocolWriter = new ProtocolWriter({
      webSocket: this,
      ioStream,
      errorHandler: this.#protocolError.bind(this) // for write errors e.g.
    })
    this.#protocolReader = new ProtocolReader({
      options: {
        highWaterMark: this.config.incomingHighWaterMark
      },
      config: this.config,
      isClient: this.#isClient,
      binaryType: this.#binaryType,
      jsonMode: this.jsonMode,
      messageHandler: this.#messageHandler.bind(this),
      pingHandler: this.#receivePing.bind(this),
      pongHandler: this.#receivePong.bind(this),
      closeHandler: this.#receiveClose.bind(this),
    })
    .on('error', this.#protocolError.bind(this))
    this.emit('open') // must be here before the write else receiveStream() could miss first message
    if (chunk?.length) this.#protocolReader.write(chunk) // before the socket pipes more
    ioStream.pipe(this.#protocolReader)
  }

  async #connectToServer(endpointUrl, protocols) {
    this.#readyState = WebSocket.CONNECTING
    try {
      const {connectToServer} = await import('./clientHandshake.js')
      const result = await connectToServer({
        endpointUrl,
        protocols,
        config: this.config, 
      })
      this.#start({
        url: result.url,
        chunk: result.chunk,
        ioStream: result.socket,
        protocol: result.protocol,
        extensions: result.extensions,
        currentStreamErrorHandler: result.socketErrorHandler
      })
    } catch (error) {
      this.#readyState = WebSocket.CLOSED
      this.emit('error', error)
      // throw error // no one to catch (since async in constructor)
    }
  }

  /** Handle the WebSocket upgrade request sent to the server, connect to client or answer with error. */
  async #handleWebSocketUpgrade(request, supportedProtocols) {
    this.#readyState = WebSocket.CONNECTING
    try {
      const {handleWebSocketUpgrade} = await import('./serverHandshake.js')
      const {ioStream, protocol, extensions, ioStreamErrorHandler} = await handleWebSocketUpgrade({
        request, supportedProtocols, config: this.config,
      })
      this.#start({
        url: (ioStream.encrypted ? 'wss://' : 'ws://')+request.headers.host+request.url,
        ioStream, protocol, extensions,
        currentStreamErrorHandler: ioStreamErrorHandler
      })
    } catch (error) {
      this.#readyState = WebSocket.CLOSED
      this.emit('error', error)
    }
  }

  #messageHandler(data, isFinal) {
    this.emit('message', {data, isFinal})
  }

  #receivePong(payload) {
    this.emit('pong', {data: payload})
  }

  /** Answer a ping frame with a pong frame. */
  #receivePing(payload) {
    if (this.#closeFrameReceived) {
      return //this.#protocolError({code: 1002, reason: 'Ping received after close.'})
    }
    this.#protocolWriter.pong(payload)
  }

  /** Triggered by protocolReader when it's destroyed and protocolWriter if error writing.
   * @private */
  async #protocolError({code, reason}) {
    // if (this.#didError) return; this.#didError = true
    this.#readyState = WebSocket.CLOSING
    this.emit('error', {code, reason})
    this.#protocolWriter.checkCloseCode = false // not on internal use
    await this.close(code, reason)
    this.#closeCode = code // setting these here since no close frame will be echoed
    this.#closeReason = reason
    this.#ioStream.destroy().unref() // end would pause reading and could hinder "close" from being emitted, but if we destroy it we're good
  }

  async #receiveClose(code, reason) {
    if (this.#closeFrameReceived) return; this.#closeFrameReceived = true
    this.#readyState = WebSocket.CLOSING
    this.#closeCode = code
    this.#closeReason = reason
    this.#protocolWriter.checkCloseCode = false // not on internal use
    await this.close(code == 1005 ? 1000 : code, reason) // also echo reason
    if (this.#isServer) this.#ioStream.end().unref() // the server gets the honor...
  }

  ref() {this.#ioStream.ref()}
  unref() {this.#ioStream.unref()}
}
