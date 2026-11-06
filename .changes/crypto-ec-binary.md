---
bump: minor
---

Add the 42 binary-field curves that OpenSSL lists (`sect*`, `c2pnb*`, `c2tnb*`, `wap-wsg-idm-ecid-wtls1` to `wtls11`, `Oakley-EC2N-3` and `Oakley-EC2N-4`) to `silk.crypto.ec` and `EcCurve`, with ECDSA, ECDH, and SEC1 point encodings. Add `EcError.UnsupportedCurve` for ECDSA on the Oakley curves, whose order is not prime, and make the `EcKeyDer` writers return `UnsupportedCurve` for them, since they have no object identifier.
