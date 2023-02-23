
import * as crypto from 'node:crypto'

export const MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
export const ZZZZFFFF = Buffer.from([0x00, 0x00, 0xFF, 0xFF])

export const Opcode = { // WebSocket frame opcodes
  continuation: 0x00, // continues a fragmented message
  // data frames (used to send a message which might be fragmented)
  text: 0x01, // UTF-8 encoded text (must be valid UTF-8)
  binary: 0x02, // binary data
  // control frames (can be interjected in the middle of a fragmented message)
  close: 0x08, 
  ping: 0x09,
  pong: 0x0A
}

export const validServerCodes = [1000,1001,1002,1003,1007,1008,1009,1011,1012,1013,1014]
export const validClientCodes = [1000,1001,1002,1003,1007,1008,1009,1010]
const closeCodeExplanationMap = new Map([
  [1000, 'Normal closure.'],
  [1001, 'Going away.'],
  [1002, 'Protocol error.'],
  [1003, 'Unsupported message type.'],
  [1005, 'No close code received.'],
  [1006, 'Abnormal closure.'],
  [1007, 'Invalid payload data.'],
  [1008, 'Policy violation.'],
  [1009, 'Message too big.'],
  [1010, 'The server rejected a mandatory extension.'],
  [1011, 'Internal server error.'],
  [1012, 'Service restart.'],
  [1013, 'Try again later.'],
  [1014, 'The server was acting as a gateway or proxy and received an invalid response from the upstream server.'],
  [1015, 'TLS handshake failure.']
])

export function closeCodeExplanation(code) {
  if (code >= 3000 && code <= 3999) {
    return 'Reserved for use by libraries, frameworks, and applications. These codes should be registered at IANA.'
  } else if (code >= 4000 && code <= 4999) {
    return 'Reserved for private use, can\'t be registered.'
  } else {
    return closeCodeExplanationMap.get(code) || 'Invalid or unknown code.'
  }
}

/** This is kept simple, meaning it might not throw on invalid input. But for our purpose it should be fine. */
// See: https://www.rfc-editor.org/rfc/rfc2616#section-2.2
export function parseExtensionLine(line) {
  const tab = String.fromCodePoint(0x09)
  const reserved = new Set(['(', ')', '<', '>', '@', ':', '\\', '/', '[', ']', '?', '{', '}', tab])
  let word = '', extTitle, argTitle, quoted, escaped, args = [], exts = []
  function nextExt() {exts.push([extTitle, Object.fromEntries(args)]); args=[]; extTitle=null}
  function consumeWord() {const r = word; word = ''; return r}
  function consumeArg() {args.push([argTitle || consumeWord(), word ? consumeWord() : true]); argTitle=null}
  for (const char of line) {
    if (char == '"' && !escaped) {
      quoted = !quoted
      if (!quoted && argTitle) consumeArg()
      continue
    }
    if (quoted) {
      if (char == '\\' && !escaped) {escaped = true; continue}
      if (escaped) escaped = false
      word += char; continue
    }
    switch (char) {
      default: if (reserved.has(char)) throw Error('Invalid character in header field: '+char)
        word += char; break
      case '=': argTitle = consumeWord(); break
      case ' ': if (word) consumeArg(); break
      case ';': if (!extTitle) extTitle = consumeWord(); break
      case ',': if (!extTitle) extTitle = consumeWord(); else if (word) consumeArg(); nextExt()
    }
  }
  if (!extTitle) extTitle = consumeWord()
  else if (argTitle || word) consumeArg()
  if (extTitle) nextExt()
  return exts
}

export function generatePermessageDeflateExtLine(isClient, {
  clientMaxWindowBits, serverMaxWindowBits,
  clientKeepSlidingWindow, serverKeepSlidingWindow
}) {
  let line = 'permessage-deflate'
  if (clientMaxWindowBits != 15) line += '; client_max_window_bits='+clientMaxWindowBits
  else if (isClient) line += '; client_max_window_bits' // indicate support for lower bits to be set
  if (serverMaxWindowBits != 15) line += '; server_max_window_bits='+serverMaxWindowBits
  if (!clientKeepSlidingWindow) line += '; client_no_context_takeover'
  if (!serverKeepSlidingWindow) line += '; server_no_context_takeover'
  return line
}

export function parsePermessageDeflateExtLine(line) {
  let result = {}
  const offers = parseExtensionLine(line.toLowerCase())
  for (const [extension, parameters] of offers) {
    if (extension != 'permessage-deflate') throw Error('Extension not supported: '+extension) // todo: then don't use it
    for (const [parameter, value] of Object.entries(parameters)) {
      switch (parameter) {
        default: throw Error('No such permessage-deflate parameter: '+parameters)
        // max windowBits client/server can use to compress data
        case 'client_max_window_bits': result.clientMaxWindowBits = value === true ? value : +value; break
        case 'server_max_window_bits': result.serverMaxWindowBits = value === true ? value : +value; break
        // whether the client/server should reset the sliding window after sending a message
        case 'client_no_context_takeover': result.clientDiscardSlidingWindow = true; break
        case 'server_no_context_takeover': result.serverDiscardSlidingWindow = true; break
      }
    }
    return result // accept first offer
  }
  throw Error('Invalid extension list: '+line)
}

export function headersToString(headers) {
  let text = ''
  for (const key in headers) {
    text += key+': '+headers[key]+'\r\n'
  }
  return text
}

export function randomSecWebSocketKey() {
  return crypto.randomBytes(16).toString('base64')
}

export function httpSchemaToWsSchema(url) {
  switch (url.protocol) {
    case 'http:': url.protocol = 'ws'; break
    case 'https:': url.protocol = 'wss'; break
  }
  return url.toString()
}

/** Mask/unmask the data in-place, the key is aligned to 32 bits. */
export function xorWithMaskingKey(maskingKey, data) {
  for (let i=0; i<data.length; i++) {
    const byte = data[i] // (it's a subclass of Uint8Array)
    const mask = maskingKey[i % 4]
    data[i] = byte ^ mask
  }
}
