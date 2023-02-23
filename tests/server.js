
import {WebSocket} from '../source/websocket.js'
import * as http from 'node:http'
const log = console.log
let server = true

http.createServer((request, response) => {
  response.writeHead(200)
  response.end('Hello, World!')
})
.on('upgrade', (request, socket, chunk) => {
  // chunk will never contain anything, since the first chunk of the WebSocket data can only be sent by the client after negotiation (an answer to this request) has taken place.
  if (chunk.length) throw Error('Why?')
  if (request.socket !== socket) throw Error('Uh?')
  // The socket can also be found in the request. Hence we only need to hand over the request, no other arguments.
  wsConnectionHandler(new WebSocket(request, socket))
})
.listen(8080)

function wsConnectionHandler(ws) {
  ws.on('open', async () => {
    log('New connection to:', ws.socket.remoteAddress)
    ws.send('1')
    ws.send('2')
    ws.send('3')
    ws.send('4')
    ws.send('5')
  })
  ws.on('message', ({isFinal, data}) => {
    log('message', {isFinal, data})
  })
  ws.on('error', ({code, reason}) => {
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
