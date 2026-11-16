param(
  [Parameter(Mandatory=$true)][string]$Compiler,
  [string]$LlvmBin="$env:USERPROFILE\silk-windows-tools\clang+llvm-22.1.8-x86_64-pc-windows-msvc\bin"
)
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath "$PSScriptRoot/../../..").Path
$producer=(Resolve-Path -LiteralPath $Compiler).Path
$destination=Join-Path $root ('.scratch/cache-writer-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $destination | Out-Null
$archive=Join-Path $destination 'source.tar'
git -C $root archive HEAD compiler tomledit -o $archive
if($LASTEXITCODE -ne 0) {throw 'Cannot export authored compiler'}
tar -xf $archive -C $destination
if($LASTEXITCODE -ne 0) {throw 'Cannot extract authored compiler'}
$object=Join-Path $destination 'compiler/cache-writer-probe.obj'
& "$LlvmBin/clang.exe" --target=x86_64-pc-windows-msvc -O2 -ffreestanding -fno-stack-protector -Wall -Wextra -Werror -c "$PSScriptRoot/cache-writer-probe.c" -o $object
if($LASTEXITCODE -ne 0) {throw 'Cannot compile measurement companion'}
$manifest=Join-Path $destination 'compiler/silk.toml'
$main=Join-Path $destination 'compiler/src/main.silk'
$text=[IO.File]::ReadAllText($main).Replace("`r`n","`n")
$marker=$text.IndexOf('effect fn program() -> i32')
$body=$text.IndexOf('{',$marker)
if($marker -lt 0 -or $body -lt 0) {throw 'Program measurement boundary missing'}
$text=$text.Insert($body+1,"`n  unsafe cache_probe_begin()`n")
$text=$text.Insert($marker,"unsafe extern `"C`" fn cache_probe_begin() -> ()`n")
[IO.File]::WriteAllText($main,$text)
$cache=Join-Path $destination 'compiler/src/driver/SemanticCache.silk'
$text=[IO.File]::ReadAllText($cache).Replace("`r`n","`n")
$old='  if let Option<Pending>.Some {value} = move run prepare(&mut store.*, file) { run writePending(&value, creating) }'
if(!$text.Contains($old)) {throw 'Persistence measurement boundary missing'}
$text=$text.Replace($old,"  if unsafe cache_probe_phase(1) != 0 { return () }`n"+$old+"`n  let measured = unsafe cache_probe_phase(2)")
$text=$text.Replace('effect fn persist(store:',"unsafe extern `"C`" fn cache_probe_phase(phase: i32) -> i32`n`neffect fn persist(store:")
[IO.File]::WriteAllText($cache,$text)
$output=Join-Path $destination 'compiler.exe'
$definition=Join-Path $destination 'definition.toml'
$request=Join-Path $destination 'request.toml'
$text=@(
  ('manifest = ' + (ConvertTo-Json -InputObject $manifest -Compress)),
  ('stdlib = ' + (ConvertTo-Json -InputObject "$root/stdlib" -Compress)),
  '[settings]', 'modules = []',
  '[settings.profile]', 'target = "x86_64-pc-windows-msvc"', 'optimization = "speed"', 'debug = false',
  '[settings.native]', 'sources = []',
  ('link = [{ kind = "object", value = ' + (ConvertTo-Json -InputObject $object -Compress) + ', weak = false, needed = false }]')
) -join "`n"
[IO.File]::WriteAllText($definition,$text)
$env:SILK_CLANG="$LlvmBin/clang.exe"
& $producer resolve --definition $definition --output $request --artifact $output
if($LASTEXITCODE -ne 0) {throw 'Cannot resolve instrumented compiler'}
& $producer compile --request $request
if($LASTEXITCODE -ne 0) {throw 'Cannot build instrumented compiler'}
@{compiler=$output; project=(Join-Path $destination 'compiler'); source=(git -C $root rev-parse HEAD)} | ConvertTo-Json
