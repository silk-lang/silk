; Reduced foreign guard, not emitted by Silk. The signature follows Microsoft's
; PEXCEPTION_ROUTINE and the independently compiled seh-personality.c oracle.
target triple = "x86_64-pc-windows-msvc"

declare void @raise_foreign()
declare void @llvm.trap() cold noreturn nounwind

define linkonce_odr hidden i32 @__silk_foreign_personality(ptr %exception,
    i64 %frame, ptr %context, ptr %dispatcher) noinline nounwind noreturn {
entry:
  call void asm sideeffect "int $$0x29", "{cx}"(i32 7)
  unreachable
}

define void @silk_guard() noinline nounwind personality ptr @__silk_foreign_personality {
entry:
  invoke void @raise_foreign() to label %normal unwind label %unwound
normal:
  ret void
unwound:
  %pad = landingpad { ptr, i32 } cleanup
  call void @llvm.trap()
  unreachable
}
