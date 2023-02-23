
export const switchable = true // meaning it can be ran twice switching client/server
export const description = 'close with code 4000'

export function test({serverWs: endpoint1, clientWs: endpoint2, doneTrigger, log, assert, WebSocket}) {
  assert.equal(endpoint1.readyState, WebSocket.CONNECTING)
  assert.equal(endpoint2.readyState, WebSocket.CONNECTING)

  endpoint1.on('open', function() {
    this.close(4000, 'because')
    assert.equal(this.readyState, WebSocket.CLOSING)
  })

  const onClose = function({code, reason}) {
    assert.equal(this.readyState, WebSocket.CLOSED)
    assert.equal(code, 4000)
    assert.equal(reason, 'because')
    doneTrigger.switch()
  }

  endpoint1.on('close', onClose)
  endpoint2.on('close', onClose)
}
