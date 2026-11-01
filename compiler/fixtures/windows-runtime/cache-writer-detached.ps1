param([string]$Compiler, [string[]]$CompilerArguments)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CacheDetachedProbe {
  [StructLayout(LayoutKind.Sequential)] struct Security { public int size; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int size; public IntPtr reserved, desktop, title;
    public int x, y, width, height, charsX, charsY, fill, flags;
    public short show, reservedSize; public IntPtr reservedBytes, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Startup start; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name, uint access, uint sharing, ref Security security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr bytes, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr ps, IntPtr ts, bool inherit, uint flags, IntPtr environment, string cwd, ref Extended startup, out ProcessInfo info);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle, uint status);
  public static uint Run(string app, string command, string cwd) {
    var sa = new Security {size=Marshal.SizeOf(typeof(Security)), inherit=1};
    var nul = CreateFileW("NUL", 0xc0000000, 3, ref sa, 3, 128, IntPtr.Zero);
    if(nul == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
    IntPtr size=IntPtr.Zero, list=IntPtr.Zero, handles=IntPtr.Zero;
    bool initialized=false;
    try {
      InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
      list=Marshal.AllocHGlobal(size);
      if(!InitializeProcThreadAttributeList(list,1,0,ref size)) throw new System.ComponentModel.Win32Exception();
      initialized=true;
      handles=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(handles,nul);
      if(!UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero)) throw new System.ComponentModel.Win32Exception();
      var si = new Extended {start=new Startup {size=Marshal.SizeOf(typeof(Extended)), flags=0x100,input=nul,output=nul,error=nul},attributes=list};
      ProcessInfo pi;
      if(!CreateProcessW(app,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x80008,IntPtr.Zero,cwd,ref si,out pi)) throw new System.ComponentModel.Win32Exception();
      try {
        if(WaitForSingleObject(pi.process,600000)!=0) {
          TerminateProcess(pi.process,1); WaitForSingleObject(pi.process,10000);
          throw new Exception("Detached probe did not complete");
        }
        uint code; if(!GetExitCodeProcess(pi.process,out code)) throw new System.ComponentModel.Win32Exception();
        return code;
      } finally {CloseHandle(pi.thread); CloseHandle(pi.process);}
    } finally {
      if(initialized) DeleteProcThreadAttributeList(list);
      if(list!=IntPtr.Zero) Marshal.FreeHGlobal(list);
      if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
      CloseHandle(nul);
    }
  }
}
'@
$path = [IO.Path]::GetFullPath($Compiler)
$arguments = @($path) + $CompilerArguments
$quoted = foreach ($argument in $arguments) { '"' + ($argument -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }
$watch = [Diagnostics.Stopwatch]::StartNew()
$code = [CacheDetachedProbe]::Run($path, ($quoted -join ' '), (Get-Location).Path)
$watch.Stop()
@{ exitCode=$code; wallMs=$watch.Elapsed.TotalMilliseconds; detachedProcess=$true } | ConvertTo-Json
if ($code -ne 0) { throw "Detached probe exited $code" }
