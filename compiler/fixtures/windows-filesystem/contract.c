/* Independent Win32/NT contract oracle. No SDK or CRT. See README.md for proof scope. */
#include <stdint.h>
#include <stddef.h>
typedef void *HANDLE;
typedef uint16_t WCHAR;
typedef int32_t NTSTATUS;
typedef struct { uint16_t Length, MaximumLength; const WCHAR *Buffer; } UNICODE_STRING;
typedef struct { uint32_t Length; HANDLE RootDirectory; UNICODE_STRING *ObjectName;
  uint32_t Attributes; void *SecurityDescriptor, *SecurityQualityOfService; } OBJECT_ATTRIBUTES;
typedef struct { uintptr_t Status, Information; } IO_STATUS_BLOCK;
typedef struct { uint32_t Flags; HANDLE RootDirectory; uint32_t FileNameLength; WCHAR FileName[255]; } RENAME_INFO;
typedef struct { uintptr_t Internal, Transferred; uint32_t Offset, OffsetHigh; HANDLE Event; } OVERLAPPED;
__declspec(dllimport) int LockFileEx(HANDLE, uint32_t, uint32_t, uint32_t, uint32_t, OVERLAPPED *);
typedef struct { int64_t Allocation, Length; uint32_t Links; uint8_t DeletePending, Directory; } STANDARD_INFO;
_Static_assert(sizeof(OBJECT_ATTRIBUTES) == 48, "OBJECT_ATTRIBUTES ABI");
_Static_assert(sizeof(IO_STATUS_BLOCK) == 16, "IO_STATUS_BLOCK ABI");
_Static_assert(sizeof(UNICODE_STRING) == 16 && offsetof(UNICODE_STRING,Buffer) == 8, "UNICODE_STRING ABI");
_Static_assert(sizeof(STANDARD_INFO) == 24 && offsetof(STANDARD_INFO,Directory) == 21, "standard info ABI");
_Static_assert(offsetof(OBJECT_ATTRIBUTES,RootDirectory)==8 && offsetof(OBJECT_ATTRIBUTES,ObjectName)==16 && offsetof(OBJECT_ATTRIBUTES,Attributes)==24, "object attribute offsets");
_Static_assert(offsetof(RENAME_INFO, FileName) == 20, "rename counted tail");
__declspec(dllimport) NTSTATUS NtCreateFile(HANDLE *, uint32_t, OBJECT_ATTRIBUTES *, IO_STATUS_BLOCK *, int64_t *, uint32_t, uint32_t, uint32_t, uint32_t, void *, uint32_t);
__declspec(dllimport) NTSTATUS NtClose(HANDLE);
__declspec(dllimport) NTSTATUS NtQueryInformationFile(HANDLE, IO_STATUS_BLOCK *, void *, uint32_t, uint32_t);
__declspec(dllimport) NTSTATUS NtQueryVolumeInformationFile(HANDLE, IO_STATUS_BLOCK *, void *, uint32_t, uint32_t);
__declspec(dllimport) NTSTATUS NtSetInformationFile(HANDLE, IO_STATUS_BLOCK *, void *, uint32_t, uint32_t);
__declspec(dllimport) NTSTATUS NtQueryDirectoryFile(HANDLE, HANDLE, void *, void *, IO_STATUS_BLOCK *, void *, uint32_t, uint32_t, uint8_t, UNICODE_STRING *, uint8_t);
__declspec(dllimport) NTSTATUS NtReadFile(HANDLE, HANDLE, void *, void *, IO_STATUS_BLOCK *, void *, uint32_t, int64_t *, uint32_t *);
__declspec(dllimport) NTSTATUS NtWriteFile(HANDLE, HANDLE, void *, void *, IO_STATUS_BLOCK *, const void *, uint32_t, int64_t *, uint32_t *);
__declspec(dllimport) uint32_t GetCurrentDirectoryW(uint32_t, WCHAR *);
__declspec(dllimport) HANDLE CreateFileW(const WCHAR *, uint32_t, uint32_t, void *, uint32_t, uint32_t, HANDLE);
__declspec(dllimport) int CloseHandle(HANDLE);
__declspec(dllimport) int ReadFile(HANDLE, void *, uint32_t, uint32_t *, void *);
__declspec(dllimport) int WriteFile(HANDLE, const void *, uint32_t, uint32_t *, void *);
__declspec(dllimport) int SetFileInformationByHandle(HANDLE, uint32_t, void *, uint32_t);
__declspec(dllimport) int SetFilePointerEx(HANDLE, int64_t, int64_t *, uint32_t);
__declspec(dllimport) int SetFileAttributesW(const WCHAR *, uint32_t);
__declspec(dllimport) uint8_t CreateSymbolicLinkW(const WCHAR *, const WCHAR *, uint32_t);
__declspec(dllimport) int CreateDirectoryW(const WCHAR *, void *);
__declspec(dllimport) int DeviceIoControl(HANDLE, uint32_t, void *, uint32_t, void *, uint32_t, uint32_t *, void *);
__declspec(dllimport) uint32_t GetLastError(void);
__declspec(dllimport) HANDLE GetStdHandle(uint32_t);
__declspec(dllimport) void ExitProcess(uint32_t);

static WCHAR base[32768], full[32768];
static uint32_t base_len;
static uint32_t length(const WCHAR *s) { uint32_t n = 0; while(s[n]) ++n; return n; }
static const WCHAR *path(const WCHAR *leaf) {
  uint32_t n = length(leaf);
  if (base_len + n + 2 >= 32768) ExitProcess(91);
  for(uint32_t i=0;i<base_len;++i) full[i]=base[i];
  full[base_len]='\\';
  for(uint32_t i=0;i<=n;++i) full[base_len+1+i]=leaf[i];
  return full;
}
static void report(const char *s) {
  uint32_t n=0,written=0; while(s[n]) ++n;
  WriteFile(GetStdHandle((uint32_t)-11), s, n, &written, 0);
}
static void require(int truth, uint32_t line) {
  if (!truth) {
    char message[]="FAIL line 00000\n";
    for(int at=14;at>=10;--at) { message[at]=(char)('0'+line%10); line/=10; }
    report(message); ExitProcess(1);
  }
}
#define CHECK(x) require((x),__LINE__)
static HANDLE win_open(const WCHAR *leaf, uint32_t access, uint32_t sharing, uint32_t creation, uint32_t flags) {
  HANDLE h=CreateFileW(path(leaf),access,sharing,0,creation,flags,0);
  CHECK(h!=(HANDLE)(intptr_t)-1); return h;
}
static void write_byte(HANDLE h,char c) { uint32_t n=0; CHECK(WriteFile(h,&c,1,&n,0)&&n==1); }
static char read_byte(HANDLE h) {
  char c=0; uint32_t n=0; CHECK(SetFilePointerEx(h,0,0,0)); CHECK(ReadFile(h,&c,1,&n,0)&&n==1); return c;
}
static NTSTATUS nt_open(HANDLE parent,const WCHAR *name,uint32_t access,uint32_t sharing,uint32_t creation,uint32_t flags,HANDLE *out) {
  UNICODE_STRING text={(uint16_t)(length(name)*2),(uint16_t)(length(name)*2),name};
  OBJECT_ATTRIBUTES attributes={48,parent,&text,0,0,0}; IO_STATUS_BLOCK io={0};
  return NtCreateFile(out,access|0x100000,&attributes,&io,0,128,sharing,creation,flags|0x200000|0x20,0,0);
}
static NTSTATUS rename_to(HANDLE file,HANDLE parent,const WCHAR *name,uint32_t flags) {
  RENAME_INFO info={0}; IO_STATUS_BLOCK io={0}; info.Flags=flags; info.RootDirectory=parent;
  info.FileNameLength=length(name)*2; CHECK(info.FileNameLength<=510);
  for(uint32_t i=0;i<info.FileNameLength/2;++i) info.FileName[i]=name[i];
  return NtSetInformationFile(file,&io,&info,20+info.FileNameLength,65);
}
static NTSTATUS dispose(HANDLE file) { uint32_t flags=3; IO_STATUS_BLOCK io={0}; return NtSetInformationFile(file,&io,&flags,4,64); }
static uint32_t word(const uint8_t *p) { return (uint32_t)p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24; }
static HANDLE root;

/* Also linked into the Silk integration fixture. This supplies UTF-16 names without Silk's codec. */
uint32_t FsFixtureSetup(uint8_t *bytes,uint32_t capacity) {
  base_len=GetCurrentDirectoryW(32768,base); CHECK(base_len>0&&base_len<32000);
  CHECK(CreateDirectoryW(path((const WCHAR *)L"root"),0));
  CHECK(CreateDirectoryW(path((const WCHAR *)L"outside"),0));
  root=win_open((const WCHAR *)L"root",0x80000000,7,3,0x02200000);
  HANDLE h=win_open((const WCHAR *)L"outside\\sentinel",0x40000000,7,1,0x80); write_byte(h,'X'); CHECK(CloseHandle(h));
  const WCHAR surrogate[]={ 'r','o','o','t','\\',0xd800,'x',0 };
  h=win_open(surrogate,0x40000000,7,1,0x80); write_byte(h,'U'); CHECK(CloseHandle(h));
  h=win_open((const WCHAR *)L"root\\old",0xc0000000,7,1,0x80); write_byte(h,'A'); CHECK(CloseHandle(h));
  const WCHAR *native=path((const WCHAR *)L"root"); uint32_t n=length(native); CHECK(n<capacity);
  for(uint32_t i=0;i<n;++i) { CHECK(native[i]<128); bytes[i]=(uint8_t)native[i]; }
  return n;
}
uint32_t FsFixtureLinks(void) {
  if (!CreateSymbolicLinkW(path((const WCHAR *)L"root\\escape"),(const WCHAR *)L"..\\outside",3)) {
    uint32_t code=GetLastError(); if(code==1314) return code; CHECK(0);
  }
  CHECK(CreateSymbolicLinkW(path((const WCHAR *)L"root\\dangling"),(const WCHAR *)L"missing",2));
  CHECK(CreateDirectoryW(path((const WCHAR *)L"root\\junction"),0));
  HANDLE junction=win_open((const WCHAR *)L"root\\junction",0x40000000,7,3,0x02200000);
  /* MOUNT_POINT_REPARSE_BUFFER: substitute is a counted NT absolute path. */
  uint8_t buffer[2048]={0}; const WCHAR *target=path((const WCHAR *)L"outside"); uint32_t n=length(target);
  CHECK(n<500); uint16_t *units=(uint16_t *)(void *)(buffer+16);
  units[0]='\\';units[1]='?';units[2]='?';units[3]='\\';
  for(uint32_t i=0;i<n;++i) units[i+4]=target[i];
  uint16_t count=(uint16_t)((n+4)*2),data=(uint16_t)(8+count+4);
  buffer[0]=3;buffer[3]=0xa0;buffer[4]=(uint8_t)data;buffer[5]=(uint8_t)(data>>8);
  buffer[10]=(uint8_t)count;buffer[11]=(uint8_t)(count>>8);
  buffer[12]=(uint8_t)(count+2);buffer[13]=(uint8_t)((count+2)>>8);
  uint32_t returned=0; CHECK(DeviceIoControl(junction,0x900a4,buffer,8+data,0,0,&returned,0)); CHECK(CloseHandle(junction));
  return 0;
}
HANDLE FsFixtureHoldOld(void) { return win_open((const WCHAR *)L"root\\old",0x80000000,7,3,0x80); }
HANDLE FsFixtureBlockDelete(void) { return win_open((const WCHAR *)L"root\\old",0x80000000,3,3,0x80); }
void FsFixtureReadOnly(uint32_t enabled) { CHECK(SetFileAttributesW(path((const WCHAR *)L"root\\old"),enabled?1:128)); }
uint32_t FsFixtureOldByte(HANDLE handle) { return (uint8_t)read_byte(handle); }
void FsFixtureClose(HANDLE handle) { CHECK(CloseHandle(handle)); }
uint32_t FsFixtureOutsideByte(void) { HANDLE h=win_open((const WCHAR *)L"outside\\sentinel",0x80000000,7,3,0x80); char c=read_byte(h); CHECK(CloseHandle(h)); return (uint8_t)c; }
uint32_t FsFixtureTryCacheLock(void) {
  HANDLE h=win_open((const WCHAR *)L"root\\compiler.lock",0xc0000000,3,4,128);
  OVERLAPPED position={0};
  int acquired=LockFileEx(h,3,0,1,0,&position);
  uint32_t code=acquired?0:GetLastError();
  CHECK(CloseHandle(h));
  if(acquired) return 1;
  return code==33?0:code+2;
}

#ifdef CONTRACT_MAIN
void mainCRTStartup(void) {
  uint8_t root_bytes[32768]; FsFixtureSetup(root_bytes,32768);
  /* Verify the exact NT root open used by the provider. */
  WCHAR native[32768]; native[0]='\\';native[1]='?';native[2]='?';native[3]='\\';
  const WCHAR *name=path((const WCHAR *)L"root"); uint32_t n=length(name);
  for(uint32_t i=0;i<=n;++i) native[i+4]=name[i];
  HANDLE ntroot=0; CHECK(nt_open(0,native,128,7,1,1,&ntroot)==0);
  HANDLE reopened=0; CHECK(nt_open(ntroot,(const WCHAR *)L"",129,7,1,1,&reopened)==0); CHECK(NtClose(reopened)==0);
  uint64_t storage[128]={0}; IO_STATUS_BLOCK io={0};
  CHECK(NtQueryVolumeInformationFile(ntroot,&io,storage,sizeof(storage),4)==0);
  CHECK(word((uint8_t *)storage)==7 && !(word((uint8_t *)storage+4)&16));
  CHECK(NtQueryVolumeInformationFile(ntroot,&io,storage,sizeof(storage),5)==0);
  CHECK(word((uint8_t *)storage+8)==8 && word((uint8_t *)storage+12)==5505102 && word((uint8_t *)storage+16)==5439558);
  CHECK(NtClose(ntroot)==0);
  report("PASS native root, synchronous no-follow opens, local NTFS queries\n");
  HANDLE minimal=0; CHECK(nt_open(root,(const WCHAR *)L"minimal",130,7,2,64,&minimal)==0);
  CHECK(NtWriteFile(minimal,0,0,0,&io,"data",4,0,0)==0&&io.Information==4);
  int64_t eof=0; CHECK(NtSetInformationFile(minimal,&io,&eof,8,20)==0); CHECK(NtClose(minimal)==0);
  CHECK(nt_open(root,(const WCHAR *)L"minimal",129,7,1,64,&minimal)==0);
  char one=0; CHECK(NtReadFile(minimal,0,0,0,&io,&one,1,0,0)==(NTSTATUS)0xc0000011); CHECK(NtClose(minimal)==0);
  report("PASS operation-specific NT read/write/truncate access and EOF status\n");
  HANDLE old=FsFixtureHoldOld();
  HANDLE stage=win_open((const WCHAR *)L"root\\stage",0xc0010000,7,1,0x80); write_byte(stage,'B');
  CHECK(rename_to(stage,root,(const WCHAR *)L"old",2)==(NTSTATUS)0xc0000035);
  CHECK(FsFixtureOldByte(old)=='A');
  CHECK(rename_to(stage,root,(const WCHAR *)L"old",3)==0);
  CHECK(FsFixtureOldByte(old)=='A');
  HANDLE current=FsFixtureHoldOld(); CHECK(read_byte(current)=='B'); CHECK(CloseHandle(current)); CHECK(CloseHandle(old));
  report("PASS atomic create collision and replacement preserve old object handles\n");
  current=FsFixtureHoldOld(); CHECK(dispose(stage)==0); CHECK(CloseHandle(stage));
  stage=win_open((const WCHAR *)L"root\\old",0x40000000,7,1,0x80); write_byte(stage,'C'); CHECK(CloseHandle(stage));
  CHECK(read_byte(current)=='B'); CHECK(CloseHandle(current));
  report("PASS POSIX removal permits recreation while old handle remains readable\n");
  HANDLE blocker=win_open((const WCHAR *)L"root\\old",0x80000000,3,3,0x80); HANDLE denied=0;
  CHECK(nt_open(root,(const WCHAR *)L"old",0x10080,7,1,0,&denied)==(NTSTATUS)0xc0000043); CHECK(CloseHandle(blocker));
  CHECK(SetFileAttributesW(path((const WCHAR *)L"root\\old"),1));
  CHECK(nt_open(root,(const WCHAR *)L"old",0x10080,7,1,0,&denied)==0);
  CHECK(dispose(denied)==(NTSTATUS)0xc0000121); CHECK(NtClose(denied)==0);
  stage=win_open((const WCHAR *)L"root\\readonly-stage",0xc0010000,7,1,0x80);
  CHECK(rename_to(stage,root,(const WCHAR *)L"old",3)==(NTSTATUS)0xc0000022);
  CHECK(dispose(stage)==0); CHECK(CloseHandle(stage));
  CHECK(SetFileAttributesW(path((const WCHAR *)L"root\\old"),128));
  report("PASS sharing conflicts and read-only policy remain observable\n");
  uint32_t links=FsFixtureLinks();
  if(links==1314) { report("UNSUPPORTED symlink fixture: privilege absent\n"); ExitProcess(77); }
  const WCHAR *link_names[]={(const WCHAR *)L"escape",(const WCHAR *)L"junction"};
  for(uint32_t i=0;i<2;++i) {
    HANDLE link=0; CHECK(nt_open(root,link_names[i],0x10080,7,1,1,&link)==0);
    uint32_t tags[2]={0}; CHECK(NtQueryInformationFile(link,&io,tags,8,35)==0);
    CHECK(tags[0]&1024); CHECK(tags[1]==(i?0xa0000003:0xa000000c));
    CHECK(dispose(link)==0); CHECK(NtClose(link)==0); CHECK(FsFixtureOutsideByte()=='X');
  }
  report("PASS non-following directory symlink and junction deletion preserves outside target\n");
  CHECK(CreateDirectoryW(path((const WCHAR *)L"root\\directory"),0));
  CHECK(CreateSymbolicLinkW(path((const WCHAR *)L"root\\dirlink"),(const WCHAR *)L"directory",3));
  unsigned seen_surrogate=0,seen_link=0,seen_directory=0;
  for(;;) {
    NTSTATUS status=NtQueryDirectoryFile(root,0,0,0,&io,storage,sizeof(storage),60,1,0,0);
    if(status==(NTSTATUS)0x80000006) break;
    CHECK(status==0&&io.Information>=88&&io.Information<=sizeof(storage));
    uint8_t *p=(uint8_t *)storage; uint32_t len=word(p+60); CHECK(len<=510&&len<=io.Information-88&&!(len&1));
    const WCHAR *entry=(const WCHAR *)(const void *)(p+88);
    if(len==4&&entry[0]==0xd800&&entry[1]=='x') seen_surrogate++;
    if(word(p+56)&1024) { CHECK(word(p+68)==0xa000000c); seen_link++; }
    else if((word(p+56)&16)&&entry[0]!='.') seen_directory++;
  }
  CHECK(seen_surrogate==1&&seen_link==2&&seen_directory==1);
  stage=win_open((const WCHAR *)L"root\\stage2",0xc0010000,7,1,0x80); write_byte(stage,'L');
  CHECK(rename_to(stage,root,(const WCHAR *)L"dangling",2)==(NTSTATUS)0xc0000035);
  CHECK(rename_to(stage,root,(const WCHAR *)L"dangling",3)==0); CHECK(CloseHandle(stage));
  stage=win_open((const WCHAR *)L"root\\stage3",0xc0010000,7,1,0x80); write_byte(stage,'D');
  CHECK(rename_to(stage,root,(const WCHAR *)L"dirlink",3)==0); CHECK(CloseHandle(stage));
  HANDLE directory=win_open((const WCHAR *)L"root\\directory",0,7,3,0x02000000); CHECK(CloseHandle(directory));
  report("PASS final dangling and directory symlink replacement affects link itself\n");
  CHECK(CreateDirectoryW(path((const WCHAR *)L"root\\case-sensitive"),0));
  HANDLE cases=win_open((const WCHAR *)L"root\\case-sensitive",0xc0000000,7,3,0x02000000);
  uint32_t sensitive=1;
  CHECK(SetFileInformationByHandle(cases,23,&sensitive,4));
  HANDLE upper=0,lower=0;
  CHECK(nt_open(cases,(const WCHAR *)L"Name",131,7,2,64,&upper)==0);
  CHECK(nt_open(cases,(const WCHAR *)L"name",131,7,2,64,&lower)==0);
  write_byte(upper,'U'); write_byte(lower,'L');
  CHECK(read_byte(upper)=='U'&&read_byte(lower)=='L');
  CHECK(NtClose(upper)==0&&NtClose(lower)==0&&CloseHandle(cases));
  report("PASS case-sensitive NTFS directory keeps differently cased names distinct\n");
  CHECK(CloseHandle(root));
  report("PASS counted directory records preserve lone surrogates and distinguish directory links\n");
  ExitProcess(0);
}
#endif
