
export const switchable = true
export const description = 'destroy the socket'

export function test({serverWs: endpoint1, clientWs: endpoint2, doneTrigger, log, assert, WebSocket}) {
  endpoint1.on('open', function() {
    this.socket.destroy()
  })

  const onClose = function({code, reason, wasClean}) {
    assert.equal(this.readyState, WebSocket.CLOSED)
    assert.equal(code, 1006) // abnormal closure
    assert.equal(reason, undefined)
    assert.equal(wasClean, false)
    doneTrigger.switch()
  }

  endpoint1.on('close', onClose)
  endpoint2.on('close', onClose)
}
