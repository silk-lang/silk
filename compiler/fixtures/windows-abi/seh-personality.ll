; ModuleID = 'seh-personality.c'
source_filename = "seh-personality.c"
target datalayout = "e-m:w-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128"
target triple = "x86_64-pc-windows-msvc19.33.0"

@selected_personality = dso_local local_unnamed_addr global ptr @windows_personality, align 8

; Function Attrs: noinline noreturn nounwind
define dso_local noundef i32 @windows_personality(ptr readnone captures(none) %exception, i64 %frame, ptr readnone captures(none) %context, ptr readnone captures(none) %dispatcher) #0 {
entry:
  tail call void asm sideeffect "int $$0x29", "{cx}"(i32 7) #1
  unreachable
}

attributes #0 = { noinline noreturn nounwind "min-legal-vector-width"="0" "no-builtins" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #1 = { noreturn nounwind }

!llvm.dbg.cu = !{!0}
!llvm.module.flags = !{!2, !3, !4, !5}

!0 = distinct !DICompileUnit(language: DW_LANG_C11, file: !1, isOptimized: true, runtimeVersion: 0, emissionKind: NoDebug, splitDebugInlining: false, nameTableKind: None)
!1 = !DIFile(filename: "seh-personality.c", directory: ".")
!2 = !{i32 2, !"Debug Info Version", i32 3}
!3 = !{i32 1, !"wchar_size", i32 2}
!4 = !{i32 8, !"PIC Level", i32 2}
!5 = !{i32 1, !"MaxTLSAlign", i32 65536}
