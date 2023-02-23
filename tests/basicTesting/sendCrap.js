
export const switchable = true
export const description = 'send invalid data'

export function test({serverWs: endpoint1, clientWs: endpoint2, doneTrigger, log, assert, WebSocket}) {
  endpoint1.on('open', function() {
    this.socket.write('crap')
  })

  const onClose = function({code, reason, wasClean}) {
    assert.equal(this.readyState, WebSocket.CLOSED)
    assert.equal(code, 1002) // protocol error
    assert.equal(reason, 'Illegal use of the reserved bits.')
    assert.equal(wasClean, false)
    doneTrigger.switch()
  }

  endpoint1.on('close', onClose)
  endpoint2.on('close', onClose)
}
