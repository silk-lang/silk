; Reduced shape of LlvmCode.guard/invokeGuarded/defineForeignPersonality.
; Handwritten IR, not output from a Windows-capable Silk compiler.
target triple = "x86_64-pc-windows-msvc"
declare void @raise_foreign()
declare void @llvm.trap() cold noreturn nounwind

define hidden i32 @__silk_foreign_personality(i32 %version, i32 %actions,
    i64 %class, ptr %exception, ptr %context) noinline nounwind noreturn {
  call void @llvm.trap()
  unreachable
}

define void @silk_guard() noinline nounwind personality ptr @__silk_foreign_personality {
  invoke void @raise_foreign() to label %normal unwind label %unwound
normal:
  ret void
unwound:
  %pad = landingpad { ptr, i32 } cleanup
  call void @llvm.trap()
  unreachable
}
