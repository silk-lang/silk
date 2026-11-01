param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
if (-not ('SilkConsoleFixture' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SilkConsoleFixture {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint size; public IntPtr reserved, desktop, title;
    public uint x,y,width,height,columns,rows,fill,flags;
    public ushort show,reservedCount; public IntPtr reservedBytes,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct Child { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcessW(string application, IntPtr command, IntPtr processSecurity,
    IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory,
    ref Startup startup, out Child child);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint status);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle, uint status);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static uint Run(string executable) {
    // A new console is necessary for real console APIs. STARTF_USESHOWWINDOW + SW_HIDE keeps it hidden.
    Startup startup = new Startup(); startup.size = (uint)Marshal.SizeOf(typeof(Startup));
    startup.flags = 1; startup.show = 0; Child child;
    if (!CreateProcessW(executable, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, false, 0x10,
        IntPtr.Zero, null, ref startup, out child)) throw new Win32Exception();
    try {
      if (WaitForSingleObject(child.process, 30000) != 0) {
        TerminateProcess(child.process, 99); WaitForSingleObject(child.process, 10000);
        throw new Exception("Hidden console fixture timed out");
      }
      uint status; if (!GetExitCodeProcess(child.process, out status)) throw new Win32Exception();
      return status;
    } finally { CloseHandle(child.thread); CloseHandle(child.process); }
  }
}
'@
}
$status = [SilkConsoleFixture]::Run((Resolve-Path -LiteralPath $Executable).Path)
if ($status -ne 0) { throw "Console readback exited $status" }
@{ status = 'passed'; exitCode = $status; claim = 'hidden-console fixture returned success' } | ConvertTo-Json
