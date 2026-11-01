/* Independent x64 ABI and loader oracle for the diagnostic frame walk. No SDK or CRT. */
typedef unsigned long u32;
typedef unsigned long long u64;
typedef unsigned short u16;
struct RuntimeFunction { u32 begin, end, unwind; };
__declspec(dllimport) u16 RtlCaptureStackBackTrace(u32, u32, void **, u32 *);
__declspec(dllimport) struct RuntimeFunction *RtlLookupFunctionEntry(u64, u64 *, void *);
__declspec(dllimport) __declspec(noreturn) void ExitProcess(u32);
extern const void *__start_silk_frames[2], *__stop_silk_frames[2];
static volatile int sink;
__declspec(noinline) static int outer(void);
__declspec(noinline) static int inner(void);
#pragma section(".silk$M", read)
__declspec(allocate(".silk$M")) const void *outer_entry[2] = {(void *)outer, "outer"};
__declspec(allocate(".silk$M")) const void *inner_entry[2] = {(void *)inner, "inner"};

__declspec(noinline) static int inner(void) {
    void *frames[256];
    u16 count = RtlCaptureStackBackTrace(0, 256, frames, 0);
    int inner_seen = 0, outer_seen = 0;
    for (u32 i = 0; i < count; ++i) {
        u64 base = 0;
        struct RuntimeFunction *info = RtlLookupFunctionEntry((u64)frames[i] - 1, &base, 0);
        if (!info) continue;
        void *entry = (void *)(base + info->begin);
        for (const void **item = __start_silk_frames; item < __stop_silk_frames; item += 2) {
            if (item[0] != entry) continue;
            if (entry == (void *)inner) inner_seen = 1;
            if (entry == (void *)outer) {
                if (!inner_seen) return 12;
                outer_seen = 1;
            }
        }
    }
    return inner_seen && outer_seen ? 0 : 13;
}
__declspec(noinline) static int outer(void) {
    volatile char large_frame[32768];
    large_frame[0] = 17;
    large_frame[32767] = 23;
    int status = inner();
    sink = large_frame[0] + large_frame[32767];
    return status;
}
void mainCRTStartup(void) { ExitProcess((u32)outer()); }
