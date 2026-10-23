import hashlib, hmac, sys
data = sys.stdin.buffer.read()
for name in ['sha1','sha224','sha256','sha384','sha512','sha512_224','sha512_256','sha3_224','sha3_256','sha3_384','sha3_512']:
    print(name, hashlib.new({'sha512_224':'sha512_224','sha512_256':'sha512_256'}.get(name,name), data).hexdigest())
print('blake2b512', hashlib.blake2b(data).hexdigest())
print('hmac_sha256', hmac.new(b'key', data, 'sha256').hexdigest())
print('hmac_sha384', hmac.new(b'k'*200, data, 'sha384').hexdigest())
