---
bump: minor
---

Add `silk.tls.certificate_text`, which writes certificate fields as OpenSSL prints them: object names from the OpenSSL object table and dotted identifiers, distinguished names in the multiline and RFC 2253 layouts that Node.js uses, validity times, and serial numbers.
