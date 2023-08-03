
import {autobahnServerTest, clearReports, listFailed} from './autobahnTester.js'
import {WebSocket} from '../../source/websocket.js'

const serverId = 'jlc-websocket'
const webSocketConfig = {
  httpHeaders: {'Server': serverId},
  zeroMasking: true,
  utf8failFast: true,
  compression: {
    thresholdNoContext: 0, // compress even the smallest payloads
    thresholdWithContext: 0,
    // clientMaxWindowBits: 15,
    // serverMaxWindowBits: 9,
    // clientKeepSlidingWindow: true,
    // serverKeepSlidingWindow: false,
  }
}

globalThis.ignoreNotTested = true
clearReports(true, serverId)
autobahnServerTest(WebSocket, serverId, {
  // quickTest: true,
  // casesToRun: ['12.1.8'],
  // casesToRun: ['12.*', '13.*'],
  casesToRun: ['13.*'],
  // casesToExclude: ['1.2.*']
  webSocketConfig
})
