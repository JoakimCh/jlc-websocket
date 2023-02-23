
import {WebSocket} from '../source/websocket.js'
import {Trigger} from '../source/div.js'
import * as http from 'node:http'
import {strict as assert} from 'node:assert'
import * as fs from 'node:fs'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {dirname, sep as pathSep} from 'path'
const scriptDirectory = dirname(fileURLToPath(import.meta.url))+pathSep
const log = console.log

const waitingConnectionsMap = new Map()
let testId = 0

const server = http.createServer((response) => {
  response.writeHead(404)
  response.end('Fuck off!')
})
.on('upgrade', (request, _socket, chunk) => {
  if (chunk.length) throw Error('Why?')
  ;((ws, request) => {
    const url = new URL(request.url, `http://${request.headers['host']}`)
    const testId = url.searchParams.get('testId')
    if (testId) {
      // log('Connection request from testId:', testId)
      waitingConnectionsMap.get(+testId)?.switch(ws)
      waitingConnectionsMap.delete(+testId)
    }
  })(new WebSocket(request), request)
})
.on('listening', () => {
  // log('Test host ready for connections...')
})
.listen(9903, '127.0.0.1')

const verbose = false

async function serverConnection() {
  const connected = new Trigger()
  waitingConnectionsMap.set(++testId, connected)
  const clientWs = new WebSocket('http://127.0.0.1:9903?testId='+testId)
  const serverWs = await connected.promise
  serverWs.on('error', error => {if (verbose) log('server WS error:', error)}) // must catch or they will throw
  clientWs.on('error', error => {if (verbose) log('client WS error:', error)})
  if (verbose) {
    serverWs.on('close', ({code, reason, wasClean}) => {log('server WS close:', {wasClean, code, reason})})
    clientWs.on('close', ({code, reason, wasClean}) => {log('client WS close:', {wasClean, code, reason})})
  }
  return {serverWs, clientWs}
}

const testDir = scriptDirectory+'basicTesting'+pathSep
for (const file of fs.readdirSync(testDir)) {
  if (!file.endsWith('.js')) continue
  const {test, description, switchable} = await import(testDir+file)
  log('Running test: '+file+(description ? ' ('+description+')' : ''))
  const doneTrigger = new Trigger(2)
  const {serverWs, clientWs} = await serverConnection()
  console.group(); test({WebSocket, serverWs, clientWs, doneTrigger, log, assert}); console.groupEnd()
  await doneTrigger.promise
  if (switchable) {
    log('Again, but switched.')
    const doneTrigger = new Trigger(2)
    const {serverWs, clientWs} = await serverConnection()
    console.group(); test({WebSocket, serverWs: clientWs, clientWs: serverWs, doneTrigger, log, assert}); console.groupEnd()
    await doneTrigger.promise
  }
}
server.closeAllConnections()
server.close()
