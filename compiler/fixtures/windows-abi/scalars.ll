; ModuleID = 'scalars.c'
source_filename = "scalars.c"
target datalayout = "e-m:w-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128"
target triple = "x86_64-pc-windows-msvc19.33.0"

; Function Attrs: nounwind
define dso_local i8 @export_signed8(i8 noundef %value) local_unnamed_addr #0 {
entry:
  %call = tail call i8 @signed8(i8 noundef %value) #2
  ret i8 %call
}

declare dso_local i8 @signed8(i8 noundef) local_unnamed_addr #1

; Function Attrs: nounwind
define dso_local i8 @export_unsigned8(i8 noundef %value) local_unnamed_addr #0 {
entry:
  %call = tail call i8 @unsigned8(i8 noundef %value) #2
  ret i8 %call
}

declare dso_local i8 @unsigned8(i8 noundef) local_unnamed_addr #1

; Function Attrs: nounwind
define dso_local i16 @export_signed16(i16 noundef %value) local_unnamed_addr #0 {
entry:
  %call = tail call i16 @signed16(i16 noundef %value) #2
  ret i16 %call
}

declare dso_local i16 @signed16(i16 noundef) local_unnamed_addr #1

; Function Attrs: nounwind
define dso_local i16 @export_unsigned16(i16 noundef %value) local_unnamed_addr #0 {
entry:
  %call = tail call i16 @unsigned16(i16 noundef %value) #2
  ret i16 %call
}

declare dso_local i16 @unsigned16(i16 noundef) local_unnamed_addr #1

; Function Attrs: nounwind
define dso_local i8 @callback_signed8(ptr noundef readonly captures(none) %callback, i8 noundef %value) local_unnamed_addr #0 {
entry:
  %call = tail call i8 %callback(i8 noundef %value) #2
  ret i8 %call
}

; Function Attrs: nounwind
define dso_local i16 @callback_unsigned16(ptr noundef readonly captures(none) %callback, i16 noundef %value) local_unnamed_addr #0 {
entry:
  %call = tail call i16 %callback(i16 noundef %value) #2
  ret i16 %call
}

attributes #0 = { nounwind "min-legal-vector-width"="0" "no-builtins" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #1 = { "no-builtins" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #2 = { nobuiltin nounwind "no-builtins" }

!llvm.dbg.cu = !{!0}
!llvm.module.flags = !{!2, !3, !4, !5}

!0 = distinct !DICompileUnit(language: DW_LANG_C11, file: !1, isOptimized: true, runtimeVersion: 0, emissionKind: NoDebug, splitDebugInlining: false, nameTableKind: None)
!1 = !DIFile(filename: "scalars.c", directory: ".")
!2 = !{i32 2, !"Debug Info Version", i32 3}
!3 = !{i32 1, !"wchar_size", i32 2}
!4 = !{i32 8, !"PIC Level", i32 2}
!5 = !{i32 1, !"MaxTLSAlign", i32 65536}
