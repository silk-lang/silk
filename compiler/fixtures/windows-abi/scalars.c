// Header-free oracle for the x86_64-pc-windows-msvc C boundary.
_Static_assert(sizeof(void *) == 8, "Win64 pointers");
_Static_assert(sizeof(long) == 4, "LLP64 long");
_Static_assert(_Alignof(long) == 4, "LLP64 long alignment");

extern signed char signed8(signed char);
extern unsigned char unsigned8(unsigned char);
extern short signed16(short);
extern unsigned short unsigned16(unsigned short);

signed char export_signed8(signed char value) { return signed8(value); }
unsigned char export_unsigned8(unsigned char value) { return unsigned8(value); }
short export_signed16(short value) { return signed16(value); }
unsigned short export_unsigned16(unsigned short value) { return unsigned16(value); }

signed char callback_signed8(signed char (*callback)(signed char), signed char value) {
  return callback(value);
}
unsigned short callback_unsigned16(unsigned short (*callback)(unsigned short), unsigned short value) {
  return callback(value);
}
