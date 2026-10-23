# A raw HTTP server on 127.0.0.1:18081 that answers each path with a scripted, sometimes broken,
# response, for testing silk/http_client. It writes what each request looked like to requests.log.
import gzip, socket, threading, time
BIG = bytes(range(256)) * 40000
def resp(status, body=b'', headers=None, length=True):
    h = headers or []
    if length: h = h + [f'Content-Length: {len(body)}']
    return f'HTTP/1.1 {status}\r\n'.encode() + b''.join(x.encode() + b'\r\n' for x in h) + b'\r\n' + body
def chunked(parts, ext=b'', trailer=b''):
    out = b''.join(b'%x%s\r\n%s\r\n' % (len(p), ext, p) for p in parts)
    return b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' + out + b'0\r\n' + trailer + b'\r\n'
ROUTES = {
 '/ok': lambda: resp('200 OK', b'hello'),
 '/empty': lambda: resp('200 OK', b''),
 '/204': lambda: resp('204 No Content', b'', length=False),
 '/304': lambda: resp('304 Not Modified', b'', length=False),
 '/big': lambda: resp('200 OK', BIG),
 '/chunked': lambda: chunked([b'Wiki', b'pedia', b' in ', b'chunks']),
 '/chunked-tiny': lambda: chunked([bytes([65 + i % 26]) for i in range(5000)]),
 '/chunked-ext': lambda: chunked([b'abc', b'def'], ext=b';name=value'),
 '/chunked-trailer': lambda: chunked([b'abc'], trailer=b'X-Check: 1\r\n'),
 '/chunked-bad': lambda: b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nabc\r\n0\r\n\r\n',
 '/close-delimited': lambda: b'HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nuntil close',
 '/http10': lambda: b'HTTP/1.0 200 OK\r\n\r\nold server',
 '/short-body': lambda: b'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nonly this',
 '/long-body': lambda: b'HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabcdef',
 '/two-cl': lambda: b'HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Length: 4\r\n\r\nabcd',
 '/cl-te': lambda: b'HTTP/1.1 200 OK\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n',
 '/100-then-200': lambda: b'HTTP/1.1 100 Continue\r\n\r\n' + resp('200 OK', b'after continue'),
 '/103-then-200': lambda: b'HTTP/1.1 103 Early Hints\r\nLink: </a.css>\r\n\r\n' + resp('200 OK', b'after hints'),
 '/no-reason': lambda: b'HTTP/1.1 200\r\nContent-Length: 2\r\n\r\nok',
 '/status-999': lambda: resp('999 Odd', b'x'),
 '/status-abc': lambda: b'HTTP/1.1 abc OK\r\nContent-Length: 1\r\n\r\nx',
 '/bare-lf': lambda: b'HTTP/1.1 200 OK\nContent-Length: 2\n\nok',
 '/obs-fold': lambda: b'HTTP/1.1 200 OK\r\nX-A: one\r\n two\r\nContent-Length: 2\r\n\r\nok',
 '/many-headers': lambda: resp('200 OK', b'ok', [f'X-{i}: v' for i in range(300)]),
 '/huge-header': lambda: resp('200 OK', b'ok', ['X-Big: ' + 'v' * 100000]),
 '/gzip': lambda: resp('200 OK', gzip.compress(b'compressed text'), ['Content-Encoding: gzip']),
 '/garbage': lambda: bytes(range(256)),
 '/nothing': lambda: b'',
 '/r301': lambda: resp('301 Moved', b'', ['Location: /ok']),
 '/r302-rel': lambda: resp('302 Found', b'', ['Location: ok']),
 '/r307': lambda: resp('307 Temporary', b'', ['Location: http://127.0.0.1:18081/ok?x=1#frag']),
 '/r308-chain': lambda: resp('308 Permanent', b'', ['Location: /r301']),
 '/r-loop': lambda: resp('302 Found', b'', ['Location: /r-loop']),
 '/r-noloc': lambda: resp('302 Found', b'body'),
 '/r-badloc': lambda: resp('302 Found', b'', ['Location: ht!tp://bad host/']),
 '/r-other-scheme': lambda: resp('302 Found', b'', ['Location: ftp://127.0.0.1/x']),
 '/r-https': lambda: resp('302 Found', b'', ['Location: https://127.0.0.1:1/x']),
 '/no-reason-sp': lambda: b'HTTP/1.1 200 \r\nContent-Length: 2\r\n\r\nok',
 '/chunked-trailer-empty': lambda: chunked([b'abc'], trailer=b''),
 '/chunked-trailer-two': lambda: chunked([b'abc'], trailer=b'X-A: 1\r\nX-B: 2\r\n'),
 '/300-noloc': lambda: resp('300 Multiple Choices', b'pick one'),
 '/304-noloc': lambda: resp('304 Not Modified', b'', length=False),
 '/unicode-header': lambda: resp('200 OK', b'ok', ['X-Name: café']),
}
def chain(n): return resp('302 Found', b'', [f'Location: /hop{n - 1}']) if n > 0 else resp('200 OK', b'end')
log = open('requests.log', 'w')
def handle(c):
    try:
        data = b''
        while b'\r\n\r\n' not in data:
            d = c.recv(65536)
            if not d: return
            data += d
        line = data.split(b'\r\n', 1)[0].decode('latin1'); path = line.split(' ')[1]
        log.write(repr(data[:300]) + '\n'); log.flush()
        if path == '/slow':
            c.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n')
            for i in range(100): c.sendall(b'x'); time.sleep(0.1)
            return
        if path == '/hang': time.sleep(10); return
        if path.startswith('/hop'): out = chain(int(path[4:]))
        else: out = ROUTES.get(path.split('?')[0], lambda: resp('404 Not Found', b'no'))()
        c.sendall(out)
    except Exception as e:
        log.write(f'error {e}\n')
    finally:
        try: c.shutdown(socket.SHUT_WR)
        except OSError: pass
        time.sleep(0.05); c.close()
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('127.0.0.1', 18081)); s.listen(64)
while True:
    c, _ = s.accept(); threading.Thread(target=handle, args=(c,), daemon=True).start()
