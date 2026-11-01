param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [string]$OpenSsl = 'C:/Program Files/Git/usr/bin/openssl.exe',
  [string]$OutputDirectory = '.scratch/windows-https-native/server'
)
$ErrorActionPreference = 'Stop'
$binary = (Resolve-Path -LiteralPath $Executable).Path
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
$output = (Resolve-Path -LiteralPath $OutputDirectory).Path
$certificate = Join-Path $output 'root.pem'
$rootKey = Join-Path $output 'root-key.pem'
$key = Join-Path $output 'server-key.pem'
$leaf = Join-Path $output 'server.pem'
$request = Join-Path $output 'server.csr'
$extensions = Join-Path $output 'server.ext'
[IO.File]::WriteAllText($extensions, "basicConstraints=critical,CA:FALSE`nkeyUsage=critical,digitalSignature`nextendedKeyUsage=serverAuth`nsubjectAltName=IP:127.0.0.1`n")
$generation = Start-Process -FilePath $OpenSsl -ArgumentList @('req', '-x509', '-newkey', 'ec',
  '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-sha256', '-days', '1',
  '-subj', '"/CN=Silk Windows HTTPS root"', '-addext', 'basicConstraints=critical,CA:TRUE',
  '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  '-keyout', ('"' + $rootKey + '"'), '-out', ('"' + $certificate + '"')) `
  -Wait -PassThru -WindowStyle Hidden -RedirectStandardError (Join-Path $output 'certificate.log')
if ($generation.ExitCode -ne 0) { throw 'Could not create the local HTTPS fixture certificate' }
$generation.Dispose()
$generation = Start-Process -FilePath $OpenSsl -ArgumentList @('req', '-new', '-newkey', 'ec',
  '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-sha256', '-subj', '/CN=127.0.0.1',
  '-keyout', ('"' + $key + '"'), '-out', ('"' + $request + '"')) `
  -Wait -PassThru -WindowStyle Hidden -RedirectStandardError (Join-Path $output 'request.log')
if ($generation.ExitCode -ne 0) { throw 'Could not create the local HTTPS certificate request' }
$generation.Dispose()
$generation = Start-Process -FilePath $OpenSsl -ArgumentList @('x509', '-req', '-in', ('"' + $request + '"'),
  '-CA', ('"' + $certificate + '"'), '-CAkey', ('"' + $rootKey + '"'), '-set_serial', '2',
  '-days', '1', '-sha256', '-extfile', ('"' + $extensions + '"'), '-out', ('"' + $leaf + '"')) `
  -Wait -PassThru -WindowStyle Hidden -RedirectStandardError (Join-Path $output 'sign.log')
if ($generation.ExitCode -ne 0) { throw 'Could not sign the local HTTPS certificate' }
$generation.Dispose()
$reservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$reservation.Start()
$port = $reservation.LocalEndpoint.Port
$reservation.Stop()
$server = Start-Process -FilePath $OpenSsl -ArgumentList @('s_server', '-accept', "127.0.0.1:$port",
  '-cert', ('"' + $leaf + '"'), '-key', ('"' + $key + '"'), '-tls1_3', '-www', '-quiet') `
  -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $output 'server.out') `
  -RedirectStandardError (Join-Path $output 'server.err')
try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    if ($server.HasExited) { throw 'The local TLS server exited during startup' }
    $probe = [Net.Sockets.TcpClient]::new()
    try { $probe.Connect('127.0.0.1', $port); $ready = $true; break }
    catch { Start-Sleep -Milliseconds 50 }
    finally { $probe.Dispose() }
  }
  if (!$ready) { throw 'The local TLS server did not become ready' }
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $binary
  $start.Arguments = '"https://127.0.0.1:' + $port + '/" "' + $certificate + '"'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.WorkingDirectory = $output
  $start.EnvironmentVariables['SSL_CERT_FILE'] = 'root.pem'
  foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')) {
    $start.EnvironmentVariables.Remove($name)
  }
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $client = [Diagnostics.Process]::Start($start)
  $stdout = $client.StandardOutput.ReadToEndAsync()
  $stderr = $client.StandardError.ReadToEndAsync()
  if (!$client.WaitForExit(60000)) { $client.Kill(); throw 'The native HTTPS fixture timed out' }
  $stdout.Result | Set-Content -LiteralPath (Join-Path $output 'client.out')
  $stderr.Result | Set-Content -LiteralPath (Join-Path $output 'client.err')
  if ($client.ExitCode -ne 0) { throw "The native HTTPS fixture exited $($client.ExitCode): $($stderr.Result)" }
  $result = @{status = 'pass'; claims = @('TLS 1.3 against independent OpenSSL server',
    'explicit Windows PEM bundle', 'relative SSL_CERT_FILE', 'HTTP status and nonempty response',
    'system roots reject unrelated issuer with NoIssuer')}
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'results.json')
  $result | ConvertTo-Json -Depth 5
} finally {
  if (!$server.HasExited) { Stop-Process -Id $server.Id -Force }
  $server.Dispose()
}
