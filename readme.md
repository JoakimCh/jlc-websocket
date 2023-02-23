
# jlc-websocket

## Released as is

For now I've decided to share this project as it is; which could mean missing documentation, tests and information. I just wanted to have it available online...

## About

A lean and mean (not a lot of code bloat) WebSocket implementation for Node.js written in modern JavaScript. Why? Because I woke up one day and was ashamed that I hadn't written my own yet.

Should I use it? Yes, because it's awesome! It works on both the server side and the client side, has lots of features and is easy to use!

An example:
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

## Features

* Server and client implementation.
* Compression support (the permessage-deflate extension).
* Possibility to send and receive Node.js streams.
* Configurable automatic reconnection (client side only).
* Possibility to receive message fragments as they come.
* UTF-8 verification using fast native functions.
* Possibility to manually ping the connection with a custom payload.

And btw, it passes the [Autobahn](https://github.com/crossbario/autobahn-testsuite) WebSocket protocol test suite.

## Documentation

The API is compatible with the standard Web API described at MDN:
https://developer.mozilla.org/en-US/docs/Web/API/WebSocket

But in addition to that ...


