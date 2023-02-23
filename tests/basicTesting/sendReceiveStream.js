
import {Readable, Writable} from 'node:stream'

export const switchable = true
export const description = 'send/receive streams'

export async function test({serverWs: endpoint1, clientWs: endpoint2, doneTrigger, log, assert, WebSocket}) {
  let properFinish

  endpoint1.on('open', function() {
    this.sendStream(Readable.from(asyncGen('hello world')), true) // as string
    this.sendStream(Readable.from(asyncGen('nice weather')))      // as binary
    this.sendStream(Readable.from(asyncGen("what's up?")), true)
    this.sendStream(Readable.from(asyncGen('cya later')))
    this.sendStream(Readable.from(asyncGen('last one I promise')))
    this.close()
  })

  endpoint2.on('open', async function() {
    // Only callbacks are fast enough to be able to tell to put the next message into a stream before its already being received. Hence I dropped support for awaiting a promise when the stream is done (the stream 'close' event is also way too slow)...
    this.receiveStream(new WritableThing(), stream => {
      assert.equal(stream.receivedAsString, 'helloworld') // e.g. depending on this decide if next should be streamed
      this.receiveStream(new WritableThing(), stream => {
        assert.equal(stream.receivedAsString, 'niceweather')
        // the next two are queued to be received as a stream (instead of a live decision)
        this.receiveStream(new WritableThing())
        .once('close', function() {assert.equal(this.receivedAsString, "what'sup?")})
        this.receiveStream(new WritableThing())
        .once('close', function() {assert.equal(this.receivedAsString, 'cyalater')})
        {
          let message = ''
          const stream = this.receiveStream() // a readable stream is then provided
          stream.setEncoding('utf-8')
          stream.on('data', text => message += text)
          stream.on('close', () => {
            assert.equal(message, 'lastoneIpromise')
            properFinish = true // we must get this far
          })
        }
      })
    })
  })

  endpoint2.on('message', function({data}) {
    log('message:', data)
  })

  const onClose = function({code, reason, wasClean}) {
    assert.equal(code, 1000) // normal closure
    assert.equal(reason, undefined)
    assert.equal(wasClean, true)
    doneTrigger.switch()
  }

  endpoint1.on('close', onClose)
  endpoint2.on('close', onClose)

  await doneTrigger.promise
  assert(properFinish, 'no properFinish')
}


async function* asyncGen(string) {
  string = string.split(' ')
  while (string.length) {
    yield string.shift()
  }
}

class WritableThing extends Writable {
  #received = []
  _write(chunk, _encoding, callback) {
    this.#received.push(chunk); callback()
  }
  get receivedAsString() {
    return Buffer.concat(this.#received).toString()
  }
}

