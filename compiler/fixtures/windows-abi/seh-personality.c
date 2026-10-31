// Microsoft x64 PEXCEPTION_ROUTINE, without SDK headers or CRT dependencies.
struct ExceptionRecord;
struct Context;
struct DispatcherContext;
enum ExceptionDisposition { ContinueExecution, ContinueSearch, NestedException, CollidedUnwind };
typedef enum ExceptionDisposition (*ExceptionRoutine)(
    struct ExceptionRecord *, unsigned long long,
    struct Context *, struct DispatcherContext *);
__declspec(noreturn) void __fastfail(unsigned);

__declspec(noinline) __declspec(noreturn)
enum ExceptionDisposition windows_personality(
    struct ExceptionRecord *exception, unsigned long long frame,
    struct Context *context, struct DispatcherContext *dispatcher) {
  __fastfail(7); // FAST_FAIL_FATAL_APP_EXIT; no nested exception dispatch.
}

ExceptionRoutine selected_personality = windows_personality;
