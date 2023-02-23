
import * as net from 'node:net'
import {ReadableWritable, WritableReadable} from 'rw-and-wr'
const log = console.log

if (process.argv.length == 3) {
  const srv = net.createServer()
  srv.listen(1234)
  srv.on('connection', socket => {
    socket.on('data', console.log)
    socket.on('end', () => {log('end')})
    socket.on('close', () => {log('close')})
  })
} else {
  const socket = net.createConnection(1234, 'localhost')
  socket.on('connect', async () => {
    socket.end()
    setTimeout(socket => socket.end(), 2000, socket)
    return
    const wr = new WritableReadable()
    // socket.setNoDelay()
    wr.pipe(socket)
    console.time('send')
    for (let i=0; i<10000; i++) {
      wr.string('Hello World!')
      await wr.commit()
      // socket.write('Hello World!')
    }
    console.timeEnd('send')
    //wr.finish()
  })
}
