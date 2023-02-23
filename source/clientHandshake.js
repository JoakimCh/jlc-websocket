
import * as crypto from 'node:crypto'
import {get as httpGet} from 'node:http'
import {get as httpsGet} from 'node:https'
import {WebSocketError} from './div.js'
import {MAGIC_GUID} from "./protocolRelated.js"
import {randomSecWebSocketKey, httpSchemaToWsSchema,
        parsePermessageDeflateExtLine, generatePermessageDeflateExtLine} from './protocolRelated.js'

/** Connect to a HTTP server and request a WebSocket upgrade, if all is good we have a connection. */
export async function connectToServer({
  endpointUrl, 
  protocols = [],
  config
}) {
  const httpHeaders = {...config.httpHeaders}
  const secWebSocketKey = randomSecWebSocketKey()
  const hash = await crypto.subtle.digest('SHA-1', secWebSocketKey+MAGIC_GUID)
  const acceptKey = Buffer.from(hash).toString('base64')
  const urlsTried = new Set()
  const result = Object.seal({
    url: undefined,
    chunk: undefined,
    socket: undefined,
    protocol: undefined,
    extensions: undefined,
    socketErrorHandler(error) {debug('socket error during handshake:', error)}
  })
  let redirected, urlProtocol
  if (protocols.length) httpHeaders['Sec-WebSocket-Protocol'] = protocols.join(', ')
  if (config.compression) {
    httpHeaders['Sec-WebSocket-Extensions'] = generatePermessageDeflateExtLine(true, config.compression)
  }
  do { // resolve any redirects
    let getFunc
    const url = new URL(endpointUrl)
    switch (url.protocol) {
      default: throw new WebSocketError('INVALID_SCHEMA', 'URL schema not allowed, got: '+scheme.slice(0,-1)+'. In: '+url)
      case 'ws:': getFunc = httpGet; url.protocol = 'http:'; break
      case 'wss:': getFunc = httpsGet; url.protocol = 'https:'; break
      case 'http:': getFunc = httpGet; break
      case 'https:': getFunc = httpsGet; break
    }
    if (!urlProtocol) urlProtocol = url.protocol
    if (url.protocol != urlProtocol && urlProtocol == 'https:') {
      throw new WebSocketError('SECURITY_MISMATCH', 'Started with a secure connection, but was redirected to an unsecure location: '+url)
    }
    if (urlsTried.has(url.toString())) throw new WebSocketError('REDIRECT_LOOP', 'A redirect loop detected.')
    urlsTried.add(url.toString())
    if (urlsTried.size > config.maxRedirections) throw new WebSocketError('TOO_MANY_REDIRECTS', 'Max number of redirects reached.')
    if (urlsTried.size > 1 && !config.allowRedirections) throw new WebSocketError('REDIRECTIONS_NOT_ALLOWED', 'Received a redirection while not allowed to follow it.')
    redirected = await new Promise((resolve, reject) => {
      getFunc(url+'', {
        timeout: config.timeout,
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
          'Sec-WebSocket-Key': secWebSocketKey,
          'Sec-WebSocket-Version': 13,
          ...httpHeaders
        }
      })
      .on('upgrade', (response, socket, chunk) => {
        socket.on('error', result.socketErrorHandler)
        try {
          if (response.headers.upgrade?.toLowerCase() == 'websocket'
          && response.headers.connection?.toLowerCase() == 'upgrade'
          && response.headers['sec-websocket-accept'] == acceptKey) {
            if (protocols.length) {
              if (response.headers['sec-websocket-protocol']) {
                const chosenProtocol = response.headers['sec-websocket-protocol'].trim()
                if (protocols.includes(chosenProtocol)) {
                  result.protocol = chosenProtocol
                } else {
                  throw new WebSocketError('INVALID_RESPONSE', 'Server chose a subprotocol we didn\'t list: '+chosenProtocol+'. Our list: '+protocols.join())
                }
              } else {
                throw new WebSocketError('INVALID_RESPONSE', 'Server doesn\'t support any of our subprotocols.')
              }
            }
            if (config.compression) {
              if (response.headers['sec-websocket-extensions']) {
                try {
                  const {
                    clientMaxWindowBits, serverMaxWindowBits, 
                    clientDiscardSlidingWindow, serverDiscardSlidingWindow
                  } = parsePermessageDeflateExtLine(response.headers['sec-websocket-extensions'])
                  if (clientDiscardSlidingWindow) config.compression.clientKeepSlidingWindow = false
                  if (serverDiscardSlidingWindow) config.compression.serverKeepSlidingWindow = false
                  if (serverMaxWindowBits === true) {
                    throw new WebSocketError('INVALID_RESPONSE', 'Server set server_max_window_bits without a value.')
                  } else if (serverMaxWindowBits != undefined) {
                    if (serverMaxWindowBits < 8 || serverMaxWindowBits > 15) throw new WebSocketError('INVALID_RESPONSE', 'Server set invalid value for server_max_window_bits.')
                  }
                  config.compression.serverMaxWindowBits = serverMaxWindowBits || 15
                  if (clientMaxWindowBits === true) {
                    throw new WebSocketError('INVALID_RESPONSE', 'Server set client_max_window_bits without a value.')
                  } else if (clientMaxWindowBits != undefined) {
                    if (clientMaxWindowBits < 8 || clientMaxWindowBits > 15) throw new WebSocketError('INVALID_RESPONSE', 'Server set invalid value for client_max_window_bits.')
                    if (clientMaxWindowBits > config.compression.clientMaxWindowBits) throw new WebSocketError('INVALID_RESPONSE', 'Server set client_max_window_bits higher than we support.')
                    config.compression.clientMaxWindowBits = clientMaxWindowBits // allow same or lower value
                  }
                } catch (error_) {
                  throw new WebSocketError('INVALID_RESPONSE', undefined, {cause: error_})
                }
              } else {
                config.compression = false
                // throw new WebSocketError('INVALID_RESPONSE', 'Server doesn\'t support the permessage-deflate extension.')
              }
            } else if (response.headers['sec-websocket-extensions']) {
              throw new WebSocketError('INVALID_RESPONSE', 'Server suggested using an extension we didn\'t ask to use.')
            }
            result.url = httpSchemaToWsSchema(endpointUrl)
            result.socket = socket
            result.chunk = chunk
            resolve(false) // false as in no redirection
          } else {
            throw new WebSocketError('INVALID_RESPONSE', 'Invalid WebSocket handshake from server. Response headers: '+JSON.stringify(response.headers, null, 2), {cause})
          }
        } catch (error) {
          reject(error)
          socket.end().unref() // on rejections
        }
      })
      .on('response', response => {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          const {location} = response.headers
          if (!location) return reject(new WebSocketError('INVALID_REDIRECT', 'Redirect without new location in header.'))
          endpointUrl = location
          return resolve(true) // true meaning redirection
        }
        reject(new WebSocketError('INVALID_RESPONSE', 'Invalid connection request response: '+response.statusCode+' '+response.statusMessage))
      })
      .on('timeout', () => {
        reject(new WebSocketError('TIMEOUT', 'Connection timed out.'))
      })
      .on('error', error => {
        if ('bytesParsed' in error) return reject(new WebSocketError('MALFORMED', 'Malformed response.', {cause: error}))
        switch (error.code) {
          default: reject(error); break
          case 'ECONNREFUSED': reject(new WebSocketError('REFUSED', 'Connection refused.')); break
          case 'ECONNRESET': reject(new WebSocketError('REFUSED', 'Connection closed early.')); break
          case 'ENOTFOUND': reject(new WebSocketError('NOT_FOUND', 'Address not found: '+url.hostname)); break
        }
      })
    })
  } while (redirected)
  return result
}
