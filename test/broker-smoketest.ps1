#!/usr/bin/env pwsh
<#
  broker-smoketest.ps1 - validate the cxkey key-broker from a Windows box on the
  CX_Production_vNET / Meraki VPN path, running as the currently-signed-in Entra user.

  PREREQ: on the test box, sign in as the identity that holds ONE vendor-key role:
      az login            # sign in as a user holding a broker app role
      az account show     # confirm the right user is active
  Then:
      pwsh ./broker-smoketest.ps1        # PowerShell 7
      powershell .\broker-smoketest.ps1  # Windows PowerShell 5.1

  Needs the Azure CLI (az) on PATH. No secrets live in this file.
#>

# TLS 1.2 for Windows PowerShell 5.1 (endpoint requires >= 1.2)
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$AppId      = 'ce485d55-f7af-40a8-b9d3-12dd64252740'
$BrokerHost = 'func-broker-cxapi-csb2cscrdcdka3fy.centralus-01.azurewebsites.net'
$Url        = "https://$BrokerHost/api/broker/anything"
$Scope      = "api://$AppId/.default"     # /.default => v2 token (NOT --resource, which is v1)
$ExpectIp   = '10.0.0.10'                 # the private endpoint address

$script:pass = 0; $script:fail = 0
function Ok  ($m) { Write-Host "  [PASS] $m" -ForegroundColor Green; $script:pass++ }
function Bad ($m) { Write-Host "  [FAIL] $m" -ForegroundColor Red;   $script:fail++ }
function Hr  ()   { Write-Host ('-' * 64) }

function Decode-JwtPayload([string]$jwt) {
  $p = $jwt.Split('.')[1].Replace('-', '+').Replace('_', '/')
  switch ($p.Length % 4) { 2 { $p += '==' } 3 { $p += '=' } }
  [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)) | ConvertFrom-Json
}

# HTTP GET that returns @{ Code; Body } without throwing on 401/4xx, on both PS 5.1 and 7.
function Invoke-Broker([hashtable]$Headers) {
  if ($PSVersionTable.PSVersion.Major -ge 7) {
    $r = Invoke-WebRequest -Uri $Url -Headers $Headers -TimeoutSec 20 -SkipHttpErrorCheck
    $body = $null; try { $body = $r.Content | ConvertFrom-Json } catch {}
    return @{ Code = [int]$r.StatusCode; Body = $body }
  }
  try {
    $r = Invoke-WebRequest -Uri $Url -Headers $Headers -UseBasicParsing -TimeoutSec 20
    $body = $null; try { $body = $r.Content | ConvertFrom-Json } catch {}
    return @{ Code = [int]$r.StatusCode; Body = $body }
  } catch {
    $resp = $_.Exception.Response
    if ($null -ne $resp) {
      $code = [int]$resp.StatusCode
      $body = $null
      try {
        $sr  = New-Object IO.StreamReader($resp.GetResponseStream())
        $txt = $sr.ReadToEnd(); $sr.Close()
        if ($txt) { $body = $txt | ConvertFrom-Json }
      } catch {}
      return @{ Code = $code; Body = $body }
    }
    throw
  }
}

Hr; Write-Host '0) Identity & environment'; Hr
if (-not (Get-Command az -ErrorAction SilentlyContinue)) { Write-Host '  az not found on PATH'; exit 1 }
$who = (az account show --query user.name -o tsv 2>$null)
if (-not $who) { Write-Host "  not logged in - run 'az login' first"; exit 1 }
Write-Host "  signed in as: $who"

Hr; Write-Host '1) DNS - are we on the private path?'; Hr
try {
  $ip = ([System.Net.Dns]::GetHostAddresses($BrokerHost) |
          Where-Object { $_.AddressFamily -eq 'InterNetwork' } |
          Select-Object -First 1).IPAddressToString
  Write-Host "  $BrokerHost -> $ip"
  if ($ip -eq $ExpectIp) { Ok "resolves to the private endpoint ($ExpectIp)" }
  else { Bad "does NOT resolve to $ExpectIp - likely off-VPN or DNS unwired; calls will fail" }
} catch { Bad "DNS lookup failed: $($_.Exception.Message)" }

Hr; Write-Host '2) Acquire a v2 token for the broker'; Hr
$token = (az account get-access-token --scope $Scope --query accessToken -o tsv 2>$null)
if (-not $token) { Bad 'could not get a token - check the scope and that this user is assigned to the app'; Write-Host "`nSUMMARY: aborted"; exit 1 }
$token = $token.Trim()
$c = Decode-JwtPayload $token
$rolesClaim = if ($c.PSObject.Properties.Name -contains 'roles') { ($c.roles -join ',') } else { '<none>' }
Write-Host "  token acquired (ver=$($c.ver) aud=$($c.aud))"
Write-Host "  roles claim: $rolesClaim"
if ($c.ver -eq '2.0') { Ok 'v2 token' } else { Bad "expected a v2 token, got ver=$($c.ver)" }

Hr; Write-Host 'Test A - valid token => 200 + server-side key injected'; Hr
$a = Invoke-Broker @{ Authorization = "Bearer $token" }
Write-Host "  HTTP $($a.Code)"
if ($a.Code -eq 200) {
  $h = $a.Body.headers
  $key = if ($h.'X-Api-Key') { $h.'X-Api-Key' } elseif ($h.Authorization) { $h.Authorization } else { '<none>' }
  Write-Host "  injected credential echoed by vendor: $key"
  if ($key -ne '<none>') { Ok 'broker injected a key server-side' } else { Bad 'no injected credential echoed' }
} else { Bad "expected 200 (auth accepted + single role resolved); got $($a.Code)" }

Hr; Write-Host 'Test B - no token => 401 from Easy Auth (before our code)'; Hr
$b = Invoke-Broker @{}
Write-Host "  HTTP $($b.Code)"
if ($b.Code -eq 401) { Ok 'unauthenticated request rejected with 401' } else { Bad "expected 401, got $($b.Code)" }

Hr; Write-Host 'Test D - smuggled x-api-key => stripped, real key wins'; Hr
$d = Invoke-Broker @{ Authorization = "Bearer $token"; 'x-api-key' = 'attacker-supplied-key' }
Write-Host "  HTTP $($d.Code)"
if ($d.Code -eq 200) {
  $key = if ($d.Body.headers.'X-Api-Key') { $d.Body.headers.'X-Api-Key' } else { '<none>' }
  Write-Host "  vendor saw X-Api-Key: $key"
  if ($key -ne 'attacker-supplied-key') { Ok 'smuggled key was stripped/overwritten' } else { Bad 'attacker key leaked through - scrub failed' }
} else { Write-Host "  (skipped strip-check; call returned $($d.Code))" }

Hr; Write-Host "SUMMARY: $($script:pass) passed, $($script:fail) failed"; Hr
exit ([int]($script:fail -gt 0))
