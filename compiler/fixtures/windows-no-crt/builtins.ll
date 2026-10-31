; Deliberately unresolved inventory, not part of the runnable baseline.
target triple = "x86_64-pc-windows-msvc"

define i128 @signed_div(i128 %a, i128 %b) {
  %v = sdiv i128 %a, %b
  ret i128 %v
}
define i128 @unsigned_div(i128 %a, i128 %b) {
  %v = udiv i128 %a, %b
  ret i128 %v
}
define i128 @signed_rem(i128 %a, i128 %b) {
  %v = srem i128 %a, %b
  ret i128 %v
}
define i128 @unsigned_rem(i128 %a, i128 %b) {
  %v = urem i128 %a, %b
  ret i128 %v
}
define i128 @multiply(i128 %a, i128 %b) {
  %v = mul i128 %a, %b
  ret i128 %v
}
define i128 @shift(i128 %a, i128 %b) {
  %v = shl i128 %a, %b
  ret i128 %v
}
define double @signed_float(i128 %a) {
  %v = sitofp i128 %a to double
  ret double %v
}
define double @unsigned_float(i128 %a) {
  %v = uitofp i128 %a to double
  ret double %v
}
define i128 @float_signed(double %a) {
  %v = fptosi double %a to i128
  ret i128 %v
}
define i128 @float_unsigned(double %a) {
  %v = fptoui double %a to i128
  ret i128 %v
}
