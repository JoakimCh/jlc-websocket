
import {autobahnClientTest, listFailed, clearReports} from './autobahnTester.js'
import {WebSocket} from '../../source/websocket.js'

const webSocketConfig = {
  utf8failFast: true,
  compression: {
    thresholdNoContext: 0,
    thresholdWithContext: 0,
    // clientMaxWindowBits: 15,
    // clientKeepSlidingWindow: true,
  }
}

globalThis.ignoreNotTested = true
clearReports(false, 'jlc-websocket')
// autobahnClientTest(WebSocket, 'jlc-websocket', {quickTest: true})
autobahnClientTest(WebSocket, 'jlc-websocket', {
  webSocketConfig,
  casesToRun: ['6.12.2'],
})
