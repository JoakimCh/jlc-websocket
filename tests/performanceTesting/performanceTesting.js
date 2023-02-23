
import * as http from 'node:http'
import {handleWebSocketUpgrade} from '../../source/serverHandshake.js'
import {frameHeader} from '../../source/protocolWriter.js'
import {Opcode} from '../../source/protocolRelated.js'
const log = console.log
globalThis.debug = console.log

function objToNum(obj) {
  for (const key in obj) {
    obj[key] = +obj[key]
  }
}

/**
 * A dummy server for performance testing.
 * Capable of receiving as fast as possible because it just dumps any incoming traffic...
 * And capable of sending as fast as possible using precomputed messages.
 */
class DummyServer {
  #server

  constructor() {
    this.#server = http.createServer(response => response.end())
    .on('upgrade', async request => {
      const url = new URL(request.url, `http://${request.headers['host']}`)
      // const params = Object.fromEntries(url.searchParams) // spread operator no good for some reason...
      // objToNum(params)
      const {numMessages, numFragments, fragmentSize, textMessage} = JSON.parse(url.searchParams.get('json'))
      log({numMessages, numFragments, fragmentSize, textMessage})
      const {ioStream, ioStreamErrorHandler} = await handleWebSocketUpgrade({request, config: {httpHeaders: {}, compression: false}})
      ioStream.off('error', ioStreamErrorHandler)
      ioStream.on('error', error => {log('socket error:', error)})
      let receivedSize = 0 // todo, know num msg to receive and close when done
      ioStream.on('data', data => receivedSize += data.length) // flush any incoming
      if (numMessages) {
        const fragments = this.#cacheFragments(textMessage, numFragments, fragmentSize)
        const numDrains = await this.#send(ioStream, fragments, numMessages)
        this.#close(ioStream, numDrains)
      }
    })
    .listen(9904)
  }

  #cacheFragments(textMessage, numFragments, fragmentSize) {
    const fragments = []
    for (let frgCount=0; frgCount<numFragments; frgCount++) {
      const header = frameHeader({
        opcode: frgCount == 0 ? (textMessage ? Opcode.text : Opcode.binary) : Opcode.continuation,
        payloadSize: fragmentSize,
        isFinal: frgCount == numFragments-1
      })
      const payload = Buffer.alloc(fragmentSize, textMessage ? ''+frgCount : frgCount)
      fragments.push(Buffer.concat([header, payload]))
    }
    return fragments
  }

  // the TCP protocol controls the WebSocket backpressure for us
  async #send(ioStream, fragments, numMessages) {
    let numDrains = 0
    const numFragments = fragments.length
    for (let msgCount=0; msgCount<numMessages; msgCount++) {
      for (let frgCount=0; frgCount<numFragments; frgCount++) {
        ioStream.write(fragments[frgCount])
        // log(fragments[frgCount])
        if (ioStream.writableNeedDrain) { // when write returns false
          await new Promise(resolve => ioStream.once('drain', resolve))
          numDrains ++
        }
      }
    }
    return numDrains
  }

  #close(ioStream, numDrains) {
    const payload = Buffer.from('xx'+numDrains)
    payload.writeUInt16BE(1000)
    ioStream.write(Buffer.concat([
      frameHeader({opcode: Opcode.close, payloadSize: payload.length}),
      payload
    ]))
    ioStream.destroy().unref() // not a proper close handshake...
    // this.#server.closeAllConnections()
    // this.#server.close()
  }
}

// todo: also make dummy client to test speed of unmasking?

let t = new DummyServer()


