// Bidirectional loopback HTTP/2 interoperability with Node/nghttp2.
import http2 from 'node:http2'
import net from 'node:net'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtempSync, copyFileSync, writeFileSync, rmSync, realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
const root = resolve(import.meta.dirname, '../..')
const directory = mkdtempSync(join(realpathSync(tmpdir()), 'silk-http2-'))
const exe = join(directory, 'http2-test')
copyFileSync(join(root, 'compiler/conformance/native-http2/main.silk'), join(directory, 'main.silk'))
writeFileSync(join(directory, 'silk.toml'), '[package]\nname = "http2-test"\nversion = "0.0.0"\nroot = "main.silk"\n')
const compiler = process.env.SILK_COMPILER ?? 'silk'
const build = spawn(compiler, ['build', join(directory, 'main.silk'), '-o', exe,
  '--stdlib', join(root, 'stdlib'), '--clang', process.env.SILK_CLANG ?? 'clang'], {stdio:'inherit', timeout:120000})
const [buildCode] = await once(build,'exit')
assert.equal(buildCode,0,'HTTP/2 fixture compiles')
process.on('exit',()=>rmSync(directory,{recursive:true,force:true}))
const server = http2.createServer()
server.on('sessionError',e=>console.error('session',e))
server.on('stream',(stream,headers)=>{
 stream.on('error',e=>console.error('stream',e))
 const path=headers[':path']
 const body=path==='/alpha'?'alpha':path==='/beta'?'beta':'x'.repeat(100000)
 stream.additionalHeaders({':status':103,'link':'</a>; rel=preload'})
 stream.respond({':status':200,'content-length':String(body.length),'x-huffman':'www.example.com'},{waitForTrailers:true})
 stream.on('wantTrailers',()=>stream.sendTrailers({'x-finished':'yes'}))
 stream.end(body)
})
server.listen(0,'127.0.0.1');await once(server,'listening')
const child=spawn(exe,[String(server.address().port)],{stdio:'inherit'})
const timer=setTimeout(()=>child.kill('SIGKILL'),15000)
const [code]=await once(child,'exit');clearTimeout(timer)
server.close()
assert.equal(code,0,'Silk client against Node server')
console.log('Silk client / Node server passed')
const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening')
const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve))
const native=spawn(exe,[String(port),'server'],{stdio:'inherit'})
try {
 let ready=false
 for(let i=0;i<100;i++) {
  ready=await new Promise(resolve=>{const s=net.connect(port,'127.0.0.1');s.once('connect',()=>{s.destroy();resolve(true)});s.once('error',()=>resolve(false))})
  if(ready)break
  await new Promise(resolve=>setTimeout(resolve,20))
 }
 assert.ok(ready,'Silk server ready')
 const client=http2.connect(`http://127.0.0.1:${port}`)
 client.on('error',e=>console.error('client',e))
 await Promise.all(Array.from({length:8},(_,i)=>new Promise((resolve,reject)=>{
  const request=client.request({':path':`/request/${i}`,'x-repeated':'hello compressed world'})
  let body='';let trailer=false
  request.setEncoding('utf8');request.on('data',chunk=>body+=chunk)
  request.on('response',headers=>{assert.equal(headers[':status'],200);assert.equal(headers['x-silk'],'http2')})
  request.on('trailers',headers=>{assert.equal(headers['x-finished'],'yes');trailer=true})
  request.on('error',reject);request.on('end',()=>{try{assert.equal(body,'hello');assert.ok(trailer);resolve()}catch(e){reject(e)}})
  request.end()
 })))
 client.close();await once(client,'close')
 console.log('Node client / Silk server passed')
} finally {native.kill('SIGTERM');await once(native,'exit')}
