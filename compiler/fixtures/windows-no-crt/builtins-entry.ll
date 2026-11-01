target triple = "x86_64-pc-windows-msvc"
declare dllimport void @ExitProcess(i32) noreturn
declare i128 @signed_div(i128, i128)
declare i128 @unsigned_div(i128, i128)
declare i128 @signed_rem(i128, i128)
declare i128 @unsigned_rem(i128, i128)
declare i128 @multiply(i128, i128)
declare i128 @shift(i128, i128)
declare double @signed_float(i128)
declare double @unsigned_float(i128)
declare i128 @float_signed(double)
declare i128 @float_unsigned(double)

define void @mainCRTStartup() {
  %sd = call i128 @signed_div(i128 -1267650600228229401496703205376, i128 36893488147419103232)
  %sd.ok = icmp eq i128 %sd, -34359738368
  %ud = call i128 @unsigned_div(i128 1267650600228229401496703205376, i128 36893488147419103232)
  %ud.ok = icmp eq i128 %ud, 34359738368
  %sr = call i128 @signed_rem(i128 -1267650600228229401496703205377, i128 36893488147419103232)
  %sr.ok = icmp eq i128 %sr, -1
  %ur = call i128 @unsigned_rem(i128 1267650600228229401496703205377, i128 36893488147419103232)
  %ur.ok = icmp eq i128 %ur, 1
  %mul = call i128 @multiply(i128 36893488147419103232, i128 34359738368)
  %mul.ok = icmp eq i128 %mul, 1267650600228229401496703205376
  %sh = call i128 @shift(i128 1, i128 100)
  %sh.ok = icmp eq i128 %sh, 1267650600228229401496703205376
  %sf = call double @signed_float(i128 -1267650600228229401496703205376)
  %sf.ok = fcmp oeq double %sf, 0xC630000000000000
  %uf = call double @unsigned_float(i128 1267650600228229401496703205376)
  %uf.ok = fcmp oeq double %uf, 0x4630000000000000
  %fs = call i128 @float_signed(double 0xC630000000000000)
  %fs.ok = icmp eq i128 %fs, -1267650600228229401496703205376
  %fu = call i128 @float_unsigned(double 0x4630000000000000)
  %fu.ok = icmp eq i128 %fu, 1267650600228229401496703205376
  %a = and i1 %sd.ok, %ud.ok
  %b = and i1 %sr.ok, %ur.ok
  %c = and i1 %mul.ok, %sh.ok
  %d = and i1 %sf.ok, %uf.ok
  %e = and i1 %fs.ok, %fu.ok
  %f = and i1 %a, %b
  %g = and i1 %c, %d
  %h = and i1 %f, %g
  %ok = and i1 %h, %e
  %exit = select i1 %ok, i32 0, i32 1
  call void @ExitProcess(i32 %exit)
  unreachable
}
