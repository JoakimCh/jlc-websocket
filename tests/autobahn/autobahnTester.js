
import * as fs from 'node:fs'
import * as http from 'node:http'
import {fileURLToPath} from 'node:url'
import {dirname, sep as pathSep} from 'path'
import {spawn, spawnSync} from 'node:child_process'
import * as readline from 'node:readline/promises'

const log = console.log
const rl = readline.createInterface({
  input: process.stdin, 
  output: process.stdout
})
process.stdin.unref()
const scriptDirectory = dirname(fileURLToPath(import.meta.url))+pathSep
const cases = [], categories = [], subCategories = [], caseIdToIndexMap = new Map()
let serverTestInProgress, clientTestInProgress

try {
  parseIndex()
} catch (error) {
  spawnSync('wstest', ['-m', 'fuzzingclient'], {cwd: scriptDirectory}) // generate index
  parseIndex() // try again
}

export function autobahnClientTest(WebSocket, agent, {
  endpoint = 'ws://127.0.0.1:9902',
  casesToRun, casesToExclude, quickTest
} = {}) {
  if (clientTestInProgress) throw Error('Wait for other client test to end before running another.')
  clientTestInProgress = true
  const url = new URL(endpoint)
  switch (url.protocol) {
    default: throw Error('URL scheme not supported: '+url.protocol)
    case 'ws:': case 'http:': break
  }

  let doneResolve; const donePromise = new Promise(resolve => doneResolve = resolve)
  let numCasesRan = 0, numCasesRanLastReport = 0, lastReportTime = Date.now()
  let fuzzer, fuzzerStdout = '', fuzzerStderr = '', fuzzerShouldClose

  rl.on('SIGINT', async () => {
    log('Testing is to be aborted because of SIGINT (e.g. ctrl-c). 🤔')
    const timeout = new Promise(resolve => setTimeout(() => {
      log('\nNo response.')
      resolve('n')
    }, 5000))
    const question = rl.question('Print test results? Yes/No (5 seconds to respond): ')
    const answer = await Promise.race([question, timeout])
    await updateReports()
    if (answer.toLowerCase().startsWith('y')) {
      listFailed(false, agent, true, quickTest)
    } else {
      log('Goodbye then!')
    }
    process.exit(1) // also kills fuzzer
  })
  process.on('exit', _code => {
    fuzzerShouldClose = true
    fuzzer?.kill()
  }) // this will kill wstest on errors, but not run its close event

  if (!casesToRun) {
    log('Testing previosly failed client tests or tests not previosly ran...', (quickTest ? '(a "quick test" excluding 12.* and 13.*)' : ''))
    casesToRun = listFailed(false, agent, false, quickTest) // then run any failed tests
    if (!casesToRun.length) {
      log('Oh... it looks like we\'re all good! 😃')
      return
    }
    configureTests(false, endpoint, casesToRun.map(test => test.id), casesToExclude)
  } else {
    log('Testing specific client tests...')
    const toRunFilter = casesToRun
    casesToRun = getCasesToRun(casesToRun, casesToExclude)
    if (!casesToRun.length) {
      log('Oh... no test cases was selected by this casesToRun fiter array:', toRunFilter)
      if (casesToExclude) log('Maybe this casesToExclude filter array excluded them?:', casesToExclude)
      return
    }
    configureTests(false, endpoint, toRunFilter, casesToExclude)
  }
  
  fuzzer = spawn('wstest', ['-m', 'fuzzingserver'], {
    cwd: scriptDirectory, 
    detached: true // so SIGINT isn't propagated to the child
  })
  fuzzer.stdout.setEncoding('utf-8'); fuzzer.stderr.setEncoding('utf-8')
  fuzzer.stdout.on('data', text => {fuzzerStdout += text})
  fuzzer.stderr.on('data', text => {fuzzerStderr += text})
  fuzzer.on('close', async (code, signal) => {
    clientTestInProgress = false
    if (code == 1) {
      log('Autobahn fuzzingserver crashed with this output in stderr:')
      log(fuzzerStderr)
      process.exit(1)
    }
    if (!fuzzerShouldClose) {
      log('Autobahn fuzzingserver closed for some unknown reason...')
      log('Tests terminated.')
      process.exit(1)
    }
    listFailed(false, agent, true, quickTest)
    doneResolve()
  })
  fuzzer.on('spawn', () => {
    setTimeout(async () => {
      let lastCat
      for (const {id, shortDescription, categoryIndex, subCategoryIndex} of casesToRun) {
        if (categoryIndex != lastCat && categoryIndex != undefined) {
          log('# In category:', categories[categoryIndex].description+':')
        }
        lastCat = categoryIndex
        await runSingle(id)
        if (lastReportTime < Date.now() - 1000 * 5) {
          await updateReports()
        }
      }
      log('All tests completed.')
      await updateReports()
      fuzzerShouldClose = true
      fuzzer.kill()
    }, 1000)
  })

  function updateReports() {
    return new Promise(resolve => {
      if (numCasesRan == numCasesRanLastReport || numCasesRan == 0) return resolve()
      numCasesRanLastReport = numCasesRan
      lastReportTime = Date.now()
      log('# Updating reports for agent: '+agent)
      const queryString = new URLSearchParams({agent})
      const ws = new WebSocket(endpoint+'/updateReports?'+queryString, {timeout: 10_000})
      ws.addEventListener('close', resolve)
      ws.addEventListener('error', resolve)
    })
  }

  async function runSingle(testId, maxConnectionRetries = 3) {
    function runTest() {
      return new Promise(resolve => {
        let didOpen, startTime
        const queryString = new URLSearchParams({casetuple: testId, agent})
        const ws = new WebSocket(endpoint+'/runCase?'+queryString, {debug: true})
        ws.addEventListener('open', () => {
          didOpen = true
          log(testId+' started...')
          startTime = performance.now()
        })
        ws.addEventListener('ping', payload => {
          // log('got ping, size:', payload.length)
        })
        ws.addEventListener('message', ({data}) => {
          ws.send(data)
          // log('got message, size:', data.length)
        })
        ws.addEventListener('error', error => {
          // log(testId+' error event:', error)
          if (!didOpen) {
            resolve(true) // as in connection error
          }
        })
        ws.addEventListener('close', ({code, reason, wasClean}) => {
          log(testId+' finished after (ms):', +Math.round(performance.now() - startTime))
          numCasesRan ++
          resolve()
        })
      })
    }
    let retries = 0
    while (await runTest()) { // while connection fails
      await new Promise(resolve => setTimeout(resolve, 1000))
      if (++retries == maxConnectionRetries) {
        log(testId+' could not establish a connection, test not completed.')
        log('Terminating the rest of the tests!')
        process.exit(1) // break
      }
      log(testId+' failed to connect, retrying...')
    }
  }

  return donePromise
}

// Note: fuzzingclient only updates reports when finished running the selected tests, hence we do not try to run them all in one run and risk having no reports on an early exit.
export function autobahnServerTest(WebSocket, agent, {
  endpoint = 'ws://127.0.0.1:9901',
  casesToRun, casesToExclude, quickTest
} = {}) {
  if (serverTestInProgress) throw Error('Wait for other server test to end before running another.')
  serverTestInProgress = true
  const url = new URL(endpoint)
  switch (url.protocol) {
    default: throw Error('URL scheme not supported: '+url.protocol)
    case 'ws:': case 'http:': break
  }

  const batch = []
  let doneResolve; const donePromise = new Promise(resolve => doneResolve = resolve)
  let numCasesRan = 0, fuzzer, fuzzerShouldClose

  rl.on('SIGINT', async () => {
    log('Testing is to be aborted because of SIGINT (e.g. ctrl-c). 🤔')
    const timeout = new Promise(resolve => setTimeout(() => {
      log('\nNo response.')
      resolve('n')
    }, 5000))
    const question = rl.question('Print test results? Yes/No (5 seconds to respond): ')
    const answer = await Promise.race([question, timeout])
    if (answer.toLowerCase().startsWith('y')) {
      listFailed(true, agent, true, quickTest)
    } else {
      log('Goodbye then!')
    }
    process.exit(1) // also kills fuzzer
  })
  process.on('exit', _code => {
    fuzzerShouldClose?.trigger()
    fuzzer?.kill()
  }) // this will kill wstest on errors, but not run its close event

  if (!casesToRun) {
    log('Testing previosly failed client tests or tests not previosly ran...', (quickTest ? '(a "quick test" excluding 12.* and 13.*)' : ''))
    casesToRun = listFailed(true, agent, false, quickTest) // then run any failed tests
    if (!casesToRun.length) {
      log('Oh... it looks like we\'re all good! 😃')
      return
    }
  } else {
    log('Testing specific server tests...')
    const toRunFilter = casesToRun
    casesToRun = getCasesToRun(casesToRun, casesToExclude)
    if (!casesToRun.length) {
      log('Oh... no test cases was selected by this casesToRun fiter array:', toRunFilter)
      if (casesToExclude) log('Maybe this casesToExclude filter array excluded them?:', casesToExclude)
      return
    }
  }

  const wsServer = http.createServer((_request, response) => {
    response.writeHead(404)
    response.end('This is a WebSocket server currently running the Autobahn test suite.')
  })
  .on('error', error => {
    log('HTTP server error:', error)
    fuzzer.kill()
  })
  .on('upgrade', (request, socket, chunk) => {
    if (chunk.length) throw Error('Client tried to send WebSocket data before the connection was accepted.')
    if (!request.headers['user-agent'].startsWith('AutobahnTestSuite')) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n').unref()
      return
    }
    const options = {httpHeaders: {'Server': agent}}
    wsConnectionHandler(new WebSocket(request, options))
  })
  .listen(url.port, url.hostname)

  wsServer.on('listening', async () => {
    log('Server ready for testing...')
    async function runBatch() {
      fuzzerShouldClose = new Trigger()
      const fuzzerShouldCloseRef = fuzzerShouldClose
      configureTests(true, endpoint, batch.map(test => test.id)) // write config
      fuzzer = spawn('wstest', ['-m', 'fuzzingclient'], {cwd: scriptDirectory})
      let fuzzerStdout = '', fuzzerStderr = ''
      fuzzer.stdout.setEncoding('utf-8'); fuzzer.stderr.setEncoding('utf-8')
      fuzzer.stdout.on('data', text => {fuzzerStdout += text})
      fuzzer.stderr.on('data', text => {fuzzerStderr += text})
      await new Promise(resolve => {
        fuzzer.on('close', async (code, signal) => {
          resolve()
          if (code == 1) {
            log('Autobahn fuzzingserver crashed with this output in stderr:')
            log(fuzzerStderr); log('Tests terminated.')
            process.exit(1)
          }
          if (!fuzzerShouldCloseRef.triggered) {
            log('Autobahn fuzzingserver closed for some unknown reason...')
            log('Tests terminated.')
            process.exit(1)
          }
        })
      })
      batch.length = 0
    }
    for (const test of casesToRun) {
      batch.push(test)
      if (test.id.startsWith('9.') && batch.length < 5) {
        continue // slow, batch only a few
      } if ((test.id.startsWith('12.') || test.id.startsWith('13.'))) { 
        // very slow tests, do no batch them
      } else if (batch.length < 20) continue
      await runBatch()
    }
    if (batch.length) runBatch() // run any leftovers
  })

  donePromise.then(() => { // when done (if no crash)
    serverTestInProgress = false
    wsServer.closeAllConnections()
    wsServer.close()
    listFailed(true, agent, true, quickTest)
  })

  let lastCat
  function wsConnectionHandler(ws) {
    let didOpen, startTime, testId
    ws.on('open', () => {
      if (numCasesRan > casesToRun.length) throw Error('More connections opened than tests to run.')
      didOpen = true
      const {id, categoryIndex} = casesToRun[numCasesRan++]
      testId = id
      if (categoryIndex != lastCat && categoryIndex != undefined) {
        log('# In category:', categories[categoryIndex].description+':')
      }
      lastCat = categoryIndex
      log(testId+' started...')
      startTime = performance.now()
    })
    ws.on('message', ({data}) => {
      ws.send(data)
      // log(data.length)
    })
    ws.on('error', error => {
      log(testId+' error event:', error)
      if (!didOpen) {
        log(testId+' failed to connect.')
        log('Tests terminated.')
        process.exit(1)
      }
    })
    ws.on('close', () => {
      log(testId+' finished after (ms):', +Math.round(performance.now() - startTime))
      batch.pop()
      if (batch.length == 0) fuzzerShouldClose?.trigger()
      if (numCasesRan == casesToRun.length) {
        setTimeout(() => {
          log('All tests completed.')
          doneResolve()
        }, 1000)
      }
    })
  }

  return donePromise
}

export function listFailed(forServerTest, agent, printFailed = true, quickTest) {
  agent = agent.replaceAll('-','_')
  const failures = []
  const path = scriptDirectory+'reports/'+(forServerTest ? 'servers' : 'clients')+'/'
  for (const {id} of cases) {
    if (quickTest) {
      if (id.startsWith('12.') || id.startsWith('13.')) continue
    }
    const fileName = agent+'_case_'+id.replaceAll('.','_')+'.json'
    let textContent, status
    try {textContent = fs.readFileSync(path+fileName, 'utf-8')} catch {}
    if (textContent) {
      const {behavior, behaviorClose} = JSON.parse(textContent)
      switch (behavior) {
        default: throw Error('Unknown test behavior: '+behavior)
        case 'NON-STRICT':
        case 'INFORMATIONAL': continue
        case 'OK': if (behaviorClose == 'OK') continue
        case 'FAILED': case 'UNIMPLEMENTED': status = behavior
      }
    } else {
      if (globalThis.ignoreNotTested) continue
      status = 'NOT TESTED'
    }
    let note = ''
    if (id == '7.7.8' && !forServerTest) note = 'Note: This is a bogus test since the server may not use 1010 as a close code.'
    else if (id == '7.7.9' && forServerTest) note = 'Note: This is a bogus test since a client may not use 1011 as a close code.'
    if (printFailed) log(id, status, note)
    if (!note) failures.push(cases[caseIdToIndexMap.get(id)])
  }
  if (printFailed && !failures.length) {log('Conclusion: Every test seems to be a success! 😃')}
  return failures
}

export function clearReports(forServerTest, agent) {
  log('Clearing any previous reports for '+agent+'.')
  const path = scriptDirectory+'reports/'+(forServerTest ? 'servers' : 'clients')+'/'
  const files = fs.readdirSync(path)
  for (const fileName of files.filter(fileName => fileName.startsWith(agent.replaceAll('-','_')+'_case'))) {
    fs.unlinkSync(path+fileName)
    log(path+fileName)
  }
}

function getCasesToRun(casesToRunFilter, casesToExcludeFilter = []) {
  let casesToRun = []
  if (!Array.isArray(casesToRunFilter)) {
    if (typeof casesToRunFilter == 'string') {
      casesToRunFilter = [casesToRunFilter]
    } else throw Error('casesToRun must have a filter that is a string or array of strings.')
  }
  for (const filter of casesToRunFilter) {
    if (filter.endsWith('*')) {
      const mathing = cases.filter(case_ => case_.id.startsWith(filter.slice(0,-1)))
      if (!mathing.length) throw Error('No test cases match the filter: '+filter)
      casesToRun.push(...mathing)
    } else {
      const case_ = cases.find(case_ => case_.id == filter)
      if (case_) {
        casesToRun.push(case_)
      } else {
        throw Error('Test case not found: '+filter)
      }
    }
  }
  for (const filter of casesToExcludeFilter) {
    const prevCaseCount = casesToRun.length
    if (filter.endsWith('*')) {
      casesToRun = casesToRun.filter(case_ => !case_.id.startsWith(filter.slice(0,-1)))
    } else {
      casesToRun = casesToRun.filter(case_ => case_.id != filter)
    }
    if (prevCaseCount == casesToRun.length) throw Error('No cases to run match the exclude filter: '+filter)
  }
  casesToRun.sort((a,b) => a.number - b.number)
  return casesToRun
}

function parseIndex() {
  function removeHtml(text) {
    return text.replaceAll('<b>','')
              .replaceAll('</b>','')
              .replaceAll('<br>','\n')
              .replaceAll('<br/>','\n')
  }
  const catSet = new Set(), subCatSet = new Set()
  const indexPath = scriptDirectory+'reports/servers/index.html'
  const lines = fs.readFileSync(indexPath, 'utf-8').split('\n')
  for (let i=0; i<lines.length; i++) {
    if (lines[i].startsWith('      <h2>Case ')) {
      const id = lines[i].slice(15, lines[i].indexOf('</h2>', 15))
      const shortDescription = removeHtml(
        lines[i+2].slice(lines[i+2].indexOf('<br/><br/>')+10, lines[i+2].indexOf('</p>')).split('.')[0]
      )
      cases.push({id, shortDescription, number: cases.length+1})
      caseIdToIndexMap.set(id, cases.length-1)
    } else if (lines[i].startsWith('            <td class="case_category">')) {
      const values = lines[i].slice(38, lines[i].indexOf('</td>', 38))
      const id = values.slice(0, values.indexOf(' '))
      const description = values.slice(values.indexOf(' ')+1)
      if (!catSet.has(id)) {
        catSet.add(id)
        categories.push({id, description})
      }
    } else if (lines[i].startsWith('            <td class="case_subcategory" colspan="')) {
      const values = lines[i].slice(53, lines[i].indexOf('</td>', 53))
      const id = values.slice(0, values.indexOf(' '))
      const description = values.slice(values.indexOf(' ')+1)
      if (!subCatSet.has(id)) {
        subCatSet.add(id)
        subCategories.push({id, description})
      }
    }
  }
  if (!cases.length) throw Error('Error parsing index file: '+indexPath)
  function getIndexMap(array) {
    const map = new Map()
    let i = 0
    for (const {id} of array) {
      map.set(id, i++)
    }
    return map
  }
  const categoryIndex = getIndexMap(categories)
  const subCategoryIndex = getIndexMap(subCategories)
  for (const case_ of cases) {
    const caseId = case_.id.split('.')
    case_.categoryIndex = categoryIndex.get(caseId[0])
    if (caseId.length >= 2) {
      case_.subCategoryIndex = subCategoryIndex.get(caseId[0]+'.'+caseId[1])
    }
  }
}

function configureTests(serverTest, endpointUrl, toRun, toExclude) {
  const configFile = serverTest ? 'fuzzingclient.json' : 'fuzzingserver.json'
  const config = JSON.parse(fs.readFileSync(scriptDirectory+configFile, 'utf-8'))
  config['cases'] = toRun
  config['exclude-cases'] = toExclude || []
  if (serverTest) {
    config['outdir'] = './reports/servers'
    config['servers'] = [{url: endpointUrl}]
  } else {
    config['outdir'] = './reports/clients'
    config['url'] = endpointUrl
  }
  fs.writeFileSync(scriptDirectory+configFile, JSON.stringify(config, null, 2))
}

class Trigger {
  #triggered = false
  trigger() {this.#triggered = true}
  get triggered() {return this.#triggered}
}
