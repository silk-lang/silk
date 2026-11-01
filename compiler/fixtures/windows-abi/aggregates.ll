; ModuleID = 'aggregates.c'
source_filename = "aggregates.c"
target datalayout = "e-m:w-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128"
target triple = "x86_64-pc-windows-msvc19.33.0"

%struct.Five = type { [5 x i8] }
%struct.Doubles = type { double, double }
%struct.Wrapped = type { <4 x float> }

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(none)
define dso_local i8 @byte_identity(i8 returned %x.coerce) local_unnamed_addr #0 {
entry:
  ret i8 %x.coerce
}

; Function Attrs: mustprogress nocallback nofree nounwind willreturn memory(argmem: readwrite)
declare void @llvm.memcpy.p0.p0.i64(ptr noalias writeonly captures(none), ptr noalias readonly captures(none), i64, i1 immarg) #1

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(none)
define dso_local i16 @short_identity(i16 returned %x.coerce) local_unnamed_addr #0 {
entry:
  ret i16 %x.coerce
}

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(none)
define dso_local i32 @float_identity(i32 returned %x.coerce) local_unnamed_addr #0 {
entry:
  ret i32 %x.coerce
}

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(none)
define dso_local i64 @pair_identity(i64 returned %x.coerce) local_unnamed_addr #0 {
entry:
  ret i64 %x.coerce
}

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(argmem: readwrite)
define dso_local void @five_identity(ptr dead_on_unwind noalias writable writeonly sret(%struct.Five) align 1 captures(none) initializes((0, 5)) %agg.result, ptr dead_on_return noundef readonly captures(none) %x) local_unnamed_addr #2 {
entry:
  tail call void @llvm.memcpy.p0.p0.i64(ptr noundef nonnull align 1 dereferenceable(5) %agg.result, ptr noundef nonnull align 1 dereferenceable(5) %x, i64 5, i1 false)
  ret void
}

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(argmem: readwrite)
define dso_local void @doubles_identity(ptr dead_on_unwind noalias writable writeonly sret(%struct.Doubles) align 8 captures(none) initializes((0, 16)) %agg.result, ptr dead_on_return noundef readonly captures(none) %x) local_unnamed_addr #2 {
entry:
  tail call void @llvm.memcpy.p0.p0.i64(ptr noundef nonnull align 8 dereferenceable(16) %agg.result, ptr noundef nonnull align 8 dereferenceable(16) %x, i64 16, i1 false)
  ret void
}

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(none)
define dso_local i32 @empty_identity(i32 returned %x.coerce) local_unnamed_addr #0 {
entry:
  ret i32 %x.coerce
}

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(none)
define dso_local noundef <4 x float> @vector_identity(<4 x float> noundef returned %x) local_unnamed_addr #3 {
entry:
  ret <4 x float> %x
}

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(none)
define dso_local noundef <8 x float> @wide_identity(<8 x float> noundef returned %x) local_unnamed_addr #4 {
entry:
  ret <8 x float> %x
}

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(none)
define dso_local noundef <16 x float> @widest_identity(<16 x float> noundef returned %x) local_unnamed_addr #5 {
entry:
  ret <16 x float> %x
}

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(argmem: readwrite)
define dso_local void @wrapped_identity(ptr dead_on_unwind noalias writable writeonly sret(%struct.Wrapped) align 16 captures(none) initializes((0, 16)) %agg.result, ptr dead_on_return noundef readonly captures(none) %x) local_unnamed_addr #2 {
entry:
  tail call void @llvm.memcpy.p0.p0.i64(ptr noundef nonnull align 16 dereferenceable(16) %agg.result, ptr noundef nonnull align 16 dereferenceable(16) %x, i64 16, i1 false)
  ret void
}

; Function Attrs: nounwind
define dso_local i32 @call_copies(ptr dead_on_return noundef readonly captures(none) %x, <4 x float> noundef %y) local_unnamed_addr #6 {
entry:
  %byval-temp = alloca %struct.Doubles, align 8
  call void @llvm.lifetime.start.p0(ptr nonnull %byval-temp) #9
  call void @llvm.memcpy.p0.p0.i64(ptr noundef nonnull align 8 dereferenceable(16) %byval-temp, ptr noundef nonnull align 8 dereferenceable(16) %x, i64 16, i1 false)
  %call = call i32 @consume(ptr dead_on_return noundef nonnull %byval-temp, <4 x float> noundef %y) #10
  call void @llvm.lifetime.end.p0(ptr nonnull %byval-temp) #9
  ret i32 %call
}

declare dso_local i32 @consume(ptr dead_on_return noundef, <4 x float> noundef) local_unnamed_addr #7

; Function Attrs: mustprogress nocallback nofree nosync nounwind willreturn memory(argmem: readwrite)
declare void @llvm.lifetime.start.p0(ptr captures(none)) #8

; Function Attrs: mustprogress nocallback nofree nosync nounwind willreturn memory(argmem: readwrite)
declare void @llvm.lifetime.end.p0(ptr captures(none)) #8

attributes #0 = { mustprogress nofree norecurse nosync nounwind willreturn memory(none) "min-legal-vector-width"="0" "no-builtins" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #1 = { mustprogress nocallback nofree nounwind willreturn memory(argmem: readwrite) }
attributes #2 = { mustprogress nofree norecurse nosync nounwind willreturn memory(argmem: readwrite) "min-legal-vector-width"="0" "no-builtins" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #3 = { mustprogress nofree norecurse nosync nounwind willreturn memory(none) "min-legal-vector-width"="128" "no-builtins" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #4 = { mustprogress nofree norecurse nosync nounwind willreturn memory(none) "min-legal-vector-width"="256" "no-builtins" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #5 = { mustprogress nofree norecurse nosync nounwind willreturn memory(none) "min-legal-vector-width"="512" "no-builtins" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #6 = { nounwind "min-legal-vector-width"="128" "no-builtins" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #7 = { "no-builtins" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #8 = { mustprogress nocallback nofree nosync nounwind willreturn memory(argmem: readwrite) }
attributes #9 = { nounwind }
attributes #10 = { nobuiltin nounwind "no-builtins" }

!llvm.dbg.cu = !{!0}
!llvm.module.flags = !{!2, !3, !4, !5}

!0 = distinct !DICompileUnit(language: DW_LANG_C11, file: !1, isOptimized: true, runtimeVersion: 0, emissionKind: NoDebug, splitDebugInlining: false, nameTableKind: None)
!1 = !DIFile(filename: "aggregates.c", directory: ".")
!2 = !{i32 2, !"Debug Info Version", i32 3}
!3 = !{i32 1, !"wchar_size", i32 2}
!4 = !{i32 8, !"PIC Level", i32 2}
!5 = !{i32 1, !"MaxTLSAlign", i32 65536}
