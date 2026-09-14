param(
    [Parameter(Mandatory = $true)][string]$JdkRoot,
    [Parameter(Mandatory = $true)][string]$SdkRoot,
    [string]$OutputPath = "MixLab-2.7.apk"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$buildRoot = Join-Path $PSScriptRoot "build"
$assetsRoot = Join-Path $buildRoot "assets"
$generatedRoot = Join-Path $buildRoot "generated"
$classesRoot = Join-Path $buildRoot "classes"
$dexRoot = Join-Path $buildRoot "dex"
$buildTools = Join-Path $SdkRoot "build-tools\35.0.0"
$androidJar = Join-Path $SdkRoot "platforms\android-35\android.jar"
$aapt2 = Join-Path $buildTools "aapt2.exe"
$d8 = Join-Path $buildTools "d8.bat"
$zipalign = Join-Path $buildTools "zipalign.exe"
$apksigner = Join-Path $buildTools "apksigner.bat"
$javac = Join-Path $JdkRoot "bin\javac.exe"
$jar = Join-Path $JdkRoot "bin\jar.exe"
$keytool = Join-Path $JdkRoot "bin\keytool.exe"
$keystore = Join-Path $PSScriptRoot "mixlab-signing.jks"

foreach ($required in @($androidJar, $aapt2, $d8, $zipalign, $apksigner, $javac, $jar, $keytool)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing build dependency: $required" }
}

if (Test-Path -LiteralPath $buildRoot) {
    $resolvedBuild = (Resolve-Path -LiteralPath $buildRoot).Path
    if (-not $resolvedBuild.StartsWith($PSScriptRoot)) { throw "Refusing to clean outside android-app" }
    Remove-Item -LiteralPath $resolvedBuild -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $assetsRoot, $generatedRoot, $classesRoot, $dexRoot | Out-Null
Copy-Item -Path (Join-Path $projectRoot "dist\*") -Destination $assetsRoot -Recurse -Force

# Hosted update artifacts must never be embedded back into the APK.
foreach ($hostedOnlyFolder in @("downloads", "updates")) {
    $hostedOnlyPath = Join-Path $assetsRoot $hostedOnlyFolder
    if (Test-Path -LiteralPath $hostedOnlyPath) {
        Remove-Item -LiteralPath $hostedOnlyPath -Recurse -Force
    }
}

# aapt2 on Windows preserves a backslash in recursively packaged asset names.
# Flatten the nested image folder for Android and rewrite only the build copy.
$nestedAssetRoot = Join-Path $assetsRoot "assets"
if (Test-Path -LiteralPath $nestedAssetRoot) {
    Copy-Item -Path (Join-Path $nestedAssetRoot "*") -Destination $assetsRoot -Force
    foreach ($assetFile in @("app.js", "sw.js", "styles.css")) {
        $assetPath = Join-Path $assetsRoot $assetFile
        $assetText = [System.IO.File]::ReadAllText($assetPath)
        $assetText = $assetText.Replace("./assets/", "./")
        [System.IO.File]::WriteAllText($assetPath, $assetText, [System.Text.UTF8Encoding]::new($false))
    }
    Remove-Item -LiteralPath $nestedAssetRoot -Recurse -Force
}

$compiledResources = Join-Path $buildRoot "resources.zip"
$unsignedApk = Join-Path $buildRoot "MixLab-unsigned.apk"
$alignedApk = Join-Path $buildRoot "MixLab-aligned.apk"
$classesJar = Join-Path $buildRoot "classes.jar"
$signedApk = Join-Path $buildRoot "MixLab-signed.apk"

& $aapt2 compile --dir (Join-Path $PSScriptRoot "res") -o $compiledResources
if ($LASTEXITCODE -ne 0) { throw "Android resource compilation failed" }

& $aapt2 link -o $unsignedApk -I $androidJar --manifest (Join-Path $PSScriptRoot "AndroidManifest.xml") --min-sdk-version 26 --target-sdk-version 35 --version-code 9 --version-name "2.7" --auto-add-overlay -R $compiledResources -A $assetsRoot --java $generatedRoot
if ($LASTEXITCODE -ne 0) { throw "APK resource linking failed" }

$javaSources = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot "src") -Recurse -Filter "*.java" | ForEach-Object { $_.FullName })
$rSource = Join-Path $generatedRoot "com\mixlab\cocktail\R.java"
& $javac -encoding UTF-8 -source 8 -target 8 -classpath $androidJar -d $classesRoot $javaSources $rSource
if ($LASTEXITCODE -ne 0) { throw "Java compilation failed" }

& $jar --create --file $classesJar -C $classesRoot .
if ($LASTEXITCODE -ne 0) { throw "Class archive creation failed" }

$env:JAVA_HOME = $JdkRoot
& $d8 --min-api 26 --lib $androidJar --output $dexRoot $classesJar
if ($LASTEXITCODE -ne 0) { throw "DEX compilation failed" }

& $jar --update --file $unsignedApk -C $dexRoot classes.dex
if ($LASTEXITCODE -ne 0) { throw "DEX packaging failed" }

& $zipalign -f -p 4 $unsignedApk $alignedApk
if ($LASTEXITCODE -ne 0) { throw "APK alignment failed" }

if (-not (Test-Path -LiteralPath $keystore)) {
    & $keytool -genkeypair -keystore $keystore -storepass android -keypass android -alias mixlab -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=MixLab, OU=Personal, O=MixLab, L=Shanghai, C=CN"
    if ($LASTEXITCODE -ne 0) { throw "Signing key creation failed" }
}

& $apksigner sign --ks $keystore --ks-key-alias mixlab --ks-pass pass:android --key-pass pass:android --out $signedApk $alignedApk
if ($LASTEXITCODE -ne 0) { throw "APK signing failed" }

& $apksigner verify --verbose --print-certs $signedApk
if ($LASTEXITCODE -ne 0) { throw "APK signature verification failed" }

$finalPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputPath))
if (-not $finalPath.StartsWith($projectRoot)) { throw "Output must remain inside the MixLab project" }
Copy-Item -LiteralPath $signedApk -Destination $finalPath -Force
Get-Item -LiteralPath $finalPath | Select-Object FullName, Length
Get-FileHash -Algorithm SHA256 -LiteralPath $finalPath | Select-Object Algorithm, Hash
