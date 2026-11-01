$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
. "$root/install.ps1"

# Keep the real API wrapper and selection code. Model Invoke-RestMethod's transport
# contract: a JSON array is emitted as one object, including empty and singleton arrays.
$script:requests = [Collections.Generic.List[string]]::new()
$script:pages = @{}
$script:stable = $null
$script:stableStatus = 404
$script:exact = $null
function Invoke-RestMethod([string]$Uri, $Headers) {
  $script:requests.Add($Uri)
  if ($Uri.EndsWith('/releases/latest')) {
    if ($null -ne $script:stable) { return $script:stable }
    $failure = [Exception]::new('Fixture HTTP failure')
    $failure | Add-Member -MemberType NoteProperty -Name Response -Value ([pscustomobject]@{StatusCode=$script:stableStatus})
    throw $failure
  }
  if ($Uri -match '/releases\?per_page=100&page=([0-9]+)$') {
    $page = [int]$Matches[1]
    if (!$script:pages.ContainsKey($page)) { throw "Unexpected release page $page" }
    Write-Output -NoEnumerate ($script:pages[$page])
    return
  }
  if ($Uri -match '/releases/tags/') { return $script:exact }
  throw "Unexpected API request $Uri"
}

function Assert-Selection([string]$Requested, [string]$Channel, [string]$Tag, [int]$RequestCount) {
  $script:requests.Clear()
  $selected = Get-SilkRelease $Requested $Channel
  if ($selected.tag_name -cne $Tag -or $script:requests.Count -ne $RequestCount) {
    throw "Wrong release or request count for $Channel / $Requested"
  }
}

function Assert-Refusal([string]$Requested, [string]$Channel, [int]$RequestCount) {
  $script:requests.Clear()
  $refused = $false
  try { Get-SilkRelease $Requested $Channel | Out-Null } catch { $refused = $true }
  if (!$refused -or $script:requests.Count -ne $RequestCount) {
    throw "Expected refusal for $Channel / $Requested"
  }
}

$dev = [pscustomobject]@{tag_name='v0.1.0-dev.42+870af07163cd'; draft=$false; prerelease=$true}
$stableRelease = [pscustomobject]@{tag_name='v1.0.0'; draft=$false; prerelease=$false}
$draft = [pscustomobject]@{tag_name='v2.0.0-dev.1'; draft=$true; prerelease=$true}
$bootstrap = [pscustomobject]@{tag_name='bootstrap-v0.0.0'; draft=$false; prerelease=$true}
$invalid = [pscustomobject]@{tag_name='v0.1.0-dev.042'; draft=$false; prerelease=$true}
$script:pages[1] = @($draft, $bootstrap, $invalid, $stableRelease, $dev)
Assert-Selection '' 'auto' $dev.tag_name 2
Assert-Selection '' 'dev' $dev.tag_name 1

$script:stable = $stableRelease
Assert-Selection '' 'auto' 'v1.0.0' 1
Assert-Selection '' 'stable' 'v1.0.0' 1
$script:stable = $null
Assert-Refusal '' 'stable' 1
$script:stableStatus = 403
Assert-Refusal '' 'auto' 1
$script:stableStatus = 404

$script:pages[1] = @($dev)
Assert-Selection '' 'dev' $dev.tag_name 1
$script:pages[1] = @(1..100 | ForEach-Object { $draft })
$script:pages[2] = @($dev)
Assert-Selection '' 'auto' $dev.tag_name 3
$script:pages[1] = @()
Assert-Refusal '' 'dev' 1

$script:exact = $dev
Assert-Selection $dev.tag_name 'auto' $dev.tag_name 1
Assert-Refusal 'v0.1.0-dev.042' 'auto' 0
Write-Output "Windows installer release selection passed on PowerShell $($PSVersionTable.PSVersion)"
