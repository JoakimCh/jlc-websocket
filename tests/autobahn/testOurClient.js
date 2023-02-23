
import {autobahnClientTest, listFailed, clearReports} from './autobahnTester.js'
import {WebSocket} from '../../source/websocket.js'
// globalThis.ignoreNotTested = true
clearReports(false, 'jlc-websocket')
autobahnClientTest(WebSocket, 'jlc-websocket', {quickTest: true})
// autobahnClientTest(WebSocket, 'jlc-websocket', {casesToRun: ['7.1.6']})

// listFailed(false, 'jlc-websocket')
