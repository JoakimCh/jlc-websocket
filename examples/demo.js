
import {WebSocket} from '../source/websocket.js'
import * as http from 'node:http'

let server = true

if (server) {
  http.createServer((request, response) => {
    response.writeHead(200)
    response.end('Hello, World!')
  })
  .on('upgrade', (request, socket) => {
    wsConnectionHandler(new WebSocket(request, socket))
  })
  .listen(8080)
} else { // if client
  wsConnectionHandler(new WebSocket('http://localhost:8080'))
}

function wsConnectionHandler(ws) {
  ws.on('open', () => {
    console.log('New connection to:', ws.socket.remoteAddress)
    ws.send('Hello!')
  })
  ws.on('message', ({data, isFinal}) => {
    console.log(isFinal, data)
  })
}
