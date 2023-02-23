
import {WebSocket as WebSocket_our} from '../../source/websocket.js'
import WebSocket_ws from 'ws'
// import './performanceTesting.js'
const log = console.log

// todo make ws friendly so we can compare
// same test but for sending, msg size and num

function test(WebSocket, {numMessages = 0, numFragments = 10, fragmentSize = 1024, textMessage = true}, options) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify({numMessages, numFragments: 10, fragmentSize: 1024, textMessage: true})
    const queryString = new URLSearchParams({json})
    wsConnectionHandler(new WebSocket('ws://127.0.0.1:9904?'+queryString, options))
    function wsConnectionHandler(ws) {
      let startTime, endTime, wasFirst = true, totalReceived = 0, msgCount = 0
      ws.addEventListener('open', async () => {
        log('Test started...')
        const numSend = 40_000, sendSize = 1024*10, sendText = false
        const message = Buffer.allocUnsafe(sendSize)
        startTime = performance.now()
        for (let i=0; i<numSend; i++) {
          await ws.send(message)
        }
        endTime = performance.now()
        ws.close()
        // log(ws.config)
      })
      ws.addEventListener('message', ({isFinal, data}) => {
        if (wasFirst) {wasFirst = false; startTime = performance.now()}
        if (++msgCount == numMessages) endTime = performance.now()
        // log(isFinal, data[0])
        totalReceived += data.length
      })
      ws.addEventListener('error', (error) => {
        log('error event:', error)
      })
      ws.addEventListener('close', ({code, reason, wasClean}) => {
        // const endTime = performance.now()
        if (msgCount != numMessages) throw Error('Test fail')
        log('close event:', {code, numWaits: +reason, wasClean, runTime: endTime-startTime, totalReceived})
        resolve()
      })
    }
  })
}

// await test(WebSocket_ws , 40_000)
await test(WebSocket_our, 40_000, {
  // incomingHighWaterMark: 1024
})
