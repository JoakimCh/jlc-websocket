
import {autobahnClientTest, listFailed, clearReports} from './autobahnTester.js'
import WebSocket from 'ws'

clearReports(false, 'ws')
autobahnClientTest(WebSocket, 'ws', {quickTest: true})
