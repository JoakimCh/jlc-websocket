
import * as crypto from 'node:crypto'
import {MAGIC_GUID, headersToString, parsePermessageDeflateExtLine, 
        generatePermessageDeflateExtLine} from "./protocolRelated.js"
import {WebSocketError} from './div.js'

/** Handle the WebSocket upgrade request sent to the server, connect to client or answer with error. */
export async function handleWebSocketUpgrade({
  request, 
  supportedProtocols = [], 
  config
}) {
  const ioStream = request.socket
  const result = Object.seal({
    ioStream,
    protocol: undefined,
    extensions: undefined,
    ioStreamErrorHandler(error) {debug('ioStream error during handshake:', error)} // todo be siltent
  })
  ioStream.on('error', result.ioStreamErrorHandler) // or else it throws unhandled error
  const httpHeaders = {...config.httpHeaders} // a copy so we can add some
  try {
    if (request.headers.upgrade?.toLowerCase() == 'websocket') {
      const clientKey = request.headers['sec-websocket-key']
      if (clientKey && request.headers['sec-websocket-version'] == '13') {
        if (request.headers['sec-websocket-protocol']) {
          const protocolPreference = request.headers['sec-websocket-protocol'].split(',').map(v => v.trim())
          for (const protocol of protocolPreference) {
            if (supportedProtocols.includes(protocol)) {
              result.protocol = protocol
              httpHeaders['Sec-WebSocket-Protocol'] = protocol
              // an absence of this header is correct when the server doesn't support any of the suggested protocols
              break
            }
          }
        }
        if (request.headers['sec-websocket-extensions'] && config.compression) {
          const {
            clientMaxWindowBits, serverMaxWindowBits, 
            clientDiscardSlidingWindow, serverDiscardSlidingWindow
          } = parsePermessageDeflateExtLine(request.headers['sec-websocket-extensions'])
          if (clientMaxWindowBits === true) { // allow the server to decide
          } else if (clientMaxWindowBits != undefined) { // a number defining the max
            if (clientMaxWindowBits < 8 || clientMaxWindowBits > 15) throw Error('Invalid value for client_max_window_bits.')
            if (config.compression.clientMaxWindowBits > clientMaxWindowBits) {
              config.compression.clientMaxWindowBits = clientMaxWindowBits // then limit it
            } // else if less then use that value
          } else { // undefined
            config.compression.clientMaxWindowBits = 15 // then its the max (default) size
          }
          if (serverMaxWindowBits === true) {
            throw Error('server_max_window_bits was set without a value.')
          } else if (serverMaxWindowBits != undefined) { // a number defining the max
            if (serverMaxWindowBits < 8 || serverMaxWindowBits > 15) throw Error('Invalid value for server_max_window_bits.')
            if (config.compression.serverMaxWindowBits > serverMaxWindowBits) {
              config.compression.serverMaxWindowBits = serverMaxWindowBits // then limit it
            }
          }
          if (clientDiscardSlidingWindow) config.compression.clientKeepSlidingWindow = false
          if (serverDiscardSlidingWindow) config.compression.serverKeepSlidingWindow = false
          httpHeaders['Sec-WebSocket-Extensions'] = generatePermessageDeflateExtLine(false, config.compression)
        } else {
          config.compression = false
        }
        const hash = await crypto.subtle.digest('SHA-1', clientKey+MAGIC_GUID)
        const acceptKey = Buffer.from(hash).toString('base64')
        ioStream.write(
          'HTTP/1.1 101 Switching Protocols\r\n'+
          'Upgrade: websocket\r\n'+
          'Connection: Upgrade\r\n'+
          'Sec-WebSocket-Accept: '+acceptKey+'\r\n'+
          headersToString(httpHeaders)+
          '\r\n'
        )
        if (ioStream.errored) throw ioStream.errored
        return result
      }
    }
  } catch (cause) {
    ioStream.end('HTTP/1.1 400 Bad Request\r\n\r\n').unref()
    throw new WebSocketError('BAD_REQUEST', 'Request headers: '+JSON.stringify(request.headers, null, 2), {cause})
  }
}
