target triple = "x86_64-pc-windows-msvc"

; The exact storage shape of LlvmCode.activeSteps, exercised through independent C threads.
@__silk_active_steps = linkonce_odr hidden thread_local global ptr null, align 8

define ptr @readDiagnostic() {
  %state = load volatile ptr, ptr @__silk_active_steps, align 8
  ret ptr %state
}

define void @writeDiagnostic(ptr %state) {
  store volatile ptr %state, ptr @__silk_active_steps, align 8
  ret void
}
