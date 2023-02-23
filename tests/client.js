
import {WebSocket} from '../source/websocket.js'
const log = console.log

wsConnectionHandler(new WebSocket('http://localhost:9001', {}))

function wsConnectionHandler(ws) {
  ws.on('open', async () => {
    log('New connection to:', ws.socket.remoteAddress)
  })
  ws.on('message', ({isFinal, data}) => {
    log('message', {isFinal, data})
  })
  ws.on('error', (error) => {
    if (error instanceof Error) { // connection error
      log(error)
    } else { // protocol error
      const {code, reason} = error
      log('error', {code, reason})
    }
  })
  ws.on('close', ({code, reason, wasClean, codeExplanation}) => {
    log('close', {code, reason, wasClean, codeExplanation})
  })
}
