const std = @import("std");
const ip = @import("ip");
test "current compiler dependency layout" {
    std.debug.print("DepEntry size={d} align={d}\nAnalUnit size={d} optional={d}\nEdgeIndex size={d} optional={d}\nTrackedInst.Index size={d}\n", .{
        @sizeOf(ip.DepEntry), @alignOf(ip.DepEntry),
        @sizeOf(ip.AnalUnit), @sizeOf(ip.AnalUnit.Optional),
        @sizeOf(ip.DepEntry.Index), @sizeOf(ip.DepEntry.Index.Optional),
        @sizeOf(ip.TrackedInst.Index),
    });
}
