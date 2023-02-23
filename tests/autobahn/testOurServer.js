
import {autobahnServerTest, listFailed} from './autobahnTester.js'
import {WebSocket} from '../../source/websocket.js'

autobahnServerTest(WebSocket, 'jlc-websocket', {quickTest: true})
// autobahnServerTest(WebSocket, 'jlc-websocket', {
//   casesToRun: ['1.*'],
//   // casesToExclude: ['1.2.*']
// })

// listFailed(true, 'jlc-websocket')
