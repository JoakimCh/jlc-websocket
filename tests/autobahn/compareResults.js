
import * as fs from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, sep as pathSep} from 'path'
const scriptDirectory = dirname(fileURLToPath(import.meta.url))+pathSep
const log = console.log

function compare(firstAgent, secondAgent, compareClients = true) {
  firstAgent = firstAgent.replaceAll('-','_')
  secondAgent = secondAgent.replaceAll('-','_')
  const directory = scriptDirectory+'reports/'+(compareClients ? 'clients' : 'servers')+'/'
  const result = [], fileSet = (() => {
    const files = fs.readdirSync(directory).filter(v => 
      (v.startsWith(firstAgent+'_case') || 
      v.startsWith(secondAgent+'_case')) && 
      v.endsWith('.json')
    )
    return new Set(files)
  })()

  for (const file of fileSet) {
    if (file.startsWith(firstAgent+'_case')) {
      const file2 = file.replace(firstAgent+'_case', secondAgent+'_case')
      if (fileSet.has(file2)) { // has results from both
        result.push([
          JSON.parse(fs.readFileSync(directory+file, 'utf-8')),
          JSON.parse(fs.readFileSync(directory+file2, 'utf-8'))
        ])
      }
    }
  }
  // todo: maybe compare time in each category?
  result.sort((a,b) => a[0].case - b[0].case)
  log('test id | agent1 | behavior | behaviorClose | duration | agent2 | ...')
  let numWin=0, numLoose=0, numSame=0
  for (const [test1, test2] of result) {
    let icon
    if (test1.duration < test2.duration) {
      icon = '😃'; numWin++
    } else if (test1.duration > test2.duration) {
      icon = '😡'; numLoose++
    } else {
      icon = '😐'; numSame++
    }
    // log(test1.id+':', test1.behavior, test1.behaviorClose, test1.duration, '_VS_', test2.behavior, test2.behaviorClose, test2.duration, icon)
  }
  log({numWin, numSame, numLoose})
  log(result.reduce((count, v) => count + v[0].duration, 0)+' / '+result.reduce((count, v) => count + v[1].duration, 0))
}

compare('jlc-websocket', 'ws')
