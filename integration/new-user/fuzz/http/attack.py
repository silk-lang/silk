# Sends normal, large, odd and hostile requests to the guide's server on 127.0.0.1:18080 and
# checks that it answers each one sensibly and keeps serving afterwards.
import socket, time, sys
def raw(data, timeout=5, close_write=True):
    s = socket.create_connection(('127.0.0.1', 18080), timeout=timeout)
    try:
        try:
            if isinstance(data, list):
                for part in data: s.sendall(part); time.sleep(0.05)
            else: s.sendall(data)
        except (ConnectionResetError, BrokenPipeError): pass
        if close_write:
            try: s.shutdown(socket.SHUT_WR)
            except OSError: pass
        out = b''
        while True:
            try: c = s.recv(65536)
            except socket.timeout: return out + b'<<timeout>>'
            except ConnectionResetError: return out + b'<<reset>>'
            if not c: return out
            out += c
    finally: s.close()
def status(resp): return resp.split(b'\r\n', 1)[0][:60]
def health():
    r = raw(b'GET /hello HTTP/1.1\r\nHost: x\r\n\r\n')
    return r.endswith(b'hello from silk\n')
cases = [
 ('hello', b'GET /hello HTTP/1.1\r\nHost: x\r\n\r\n'),
 ('http10', b'GET /hello HTTP/1.0\r\n\r\n'),
 ('echo', b'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 8\r\n\r\nBuy milk'),
 ('echo4096', b'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 4096\r\n\r\n' + b'x' * 4096),
 ('echo4097', b'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 4097\r\n\r\n' + b'x' * 4097),
 ('echo10MB', b'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 10000000\r\n\r\n' + b'x' * 10000000),
 ('chunked', b'POST /echo HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n'),
 ('chunked17', b'POST /echo HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n' + b'1\r\na\r\n' * 17 + b'0\r\n\r\n'),
 ('badchunk', b'POST /echo HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nWiki\r\n0\r\n\r\n'),
 ('cl+te', b'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\nGET /hello HTTP/1.1\r\n\r\n'),
 ('two-cl', b'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 3\r\nContent-Length: 5\r\n\r\nabcde'),
 ('neg-cl', b'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: -1\r\n\r\n'),
 ('huge-cl', b'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 99999999999999999999999\r\n\r\n'),
 ('short-body', b'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nabc'),
 ('pipelined', b'GET /hello HTTP/1.1\r\nHost: x\r\n\r\nGET /hello HTTP/1.1\r\nHost: x\r\n\r\n'),
 ('long-target', b'GET /' + b'a' * 2000 + b' HTTP/1.1\r\nHost: x\r\n\r\n'),
 ('many-headers', b'GET /hello HTTP/1.1\r\n' + b''.join(b'X-%d: v\r\n' % i for i in range(40)) + b'\r\n'),
 ('big-header', b'GET /hello HTTP/1.1\r\nX: ' + b'v' * 5000 + b'\r\n\r\n'),
 ('bare-lf', b'GET /hello HTTP/1.1\nHost: x\n\n'),
 ('space-colon', b'GET /hello HTTP/1.1\r\nHost : x\r\n\r\n'),
 ('obs-fold', b'GET /hello HTTP/1.1\r\nHost: x\r\nX: a\r\n b\r\n\r\n'),
 ('nul', b'GET /hel\x00lo HTTP/1.1\r\nHost: x\r\n\r\n'),
 ('garbage', bytes(range(256)) * 4),
 ('empty', b''),
 ('http2-preface', b'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'),
 ('lower-method', b'get /hello HTTP/1.1\r\nHost: x\r\n\r\n'),
 ('version9', b'GET /hello HTTP/9.9\r\nHost: x\r\n\r\n'),
 ('absolute', b'GET http://x/hello HTTP/1.1\r\nHost: x\r\n\r\n'),
 ('slow-head', [b'GET /he', b'llo HTTP/1.1\r\nHo', b'st: x\r\n', b'\r\n']),
 ('expect', b'POST /echo HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\nContent-Length: 2\r\n\r\nhi'),
]
for name, data in cases:
    t = time.time(); r = raw(data); dt = time.time() - t
    body = r.split(b'\r\n\r\n', 1)[1][:40] if b'\r\n\r\n' in r else b''
    print(f'{name:14} {dt:5.2f}s {status(r)!r:50} body={body!r} alive={health()}')
