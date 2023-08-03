
# jlc-websocket

## About

A lean and mean (not a lot of code bloat) WebSocket implementation written from scratch for Node.js in modern JavaScript. No dependencies and no third-party libraries. Why? Because I woke up one day and was ashamed that I hadn't written my own yet...

Should I use it? Well, it works on both the server side and the client side, has some nice features and is easy to use! And it passes the [Autobahn](https://github.com/crossbario/autobahn-testsuite) WebSocket protocol test suite!

An example showing both server and client usage:
```js
import {WebSocket} from 'jlc-websocket'
import * as http from 'node:http'

const server = true

if (server) {
  http.createServer((request, response) => {
    response.writeHead(200)
    response.end('Hello world!')
  })
  .on('upgrade', (request) => {
    wsConnectionHandler(new WebSocket(request))
  })
  .listen(8080)
} else { // if client
  wsConnectionHandler(new WebSocket('ws://localhost:8080'))
}

function wsConnectionHandler(ws) {
  ws.on('open', () => {
    console.log('New connection to:', ws.socket.remoteAddress)
    ws.send('Hello!')
  })
  ws.on('message', ({data, isFinal}) => {
    console.log(data)
  })
}
```

## Current features

* Server and client implementation.
* Compression support (the permessage-deflate extension).
* Possibility to send and receive Node.js streams.
* Possibility to receive message fragments as they come.
* UTF-8 verification using fast native functions.
* Possibility to manually ping the connection with a custom payload.

## Todo list

* Configurable automatic reconnection (client side only).

## Documentation

The API is compatible with the standard Web API described at MDN:
https://developer.mozilla.org/en-US/docs/Web/API/WebSocket

I will write further documentation later.
