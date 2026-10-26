$ErrorActionPreference = 'Stop'

if ($env:GITHUB_ACTIONS -ne 'true') {
    throw 'Display configuration is only allowed on the disposable hosted runner'
}

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class TouchAiDisplay {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public struct DEVMODE {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion;
        public short dmDriverVersion;
        public short dmSize;
        public short dmDriverExtra;
        public int dmFields;
        public int dmPositionX;
        public int dmPositionY;
        public int dmDisplayOrientation;
        public int dmDisplayFixedOutput;
        public short dmColor;
        public short dmDuplex;
        public short dmYResolution;
        public short dmTTOption;
        public short dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels;
        public int dmBitsPerPel;
        public int dmPelsWidth;
        public int dmPelsHeight;
        public int dmDisplayFlags;
        public int dmDisplayFrequency;
        public int dmICMMethod;
        public int dmICMIntent;
        public int dmMediaType;
        public int dmDitherType;
        public int dmReserved1;
        public int dmReserved2;
        public int dmPanningWidth;
        public int dmPanningHeight;
    }

    [DllImport("user32.dll", CharSet = CharSet.Ansi)]
    public static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);

    [DllImport("user32.dll")]
    public static extern int ChangeDisplaySettings(ref DEVMODE devMode, int flags);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
}
"@

[TouchAiDisplay]::SetProcessDPIAware() | Out-Null

function Get-UsableDisplayModes {
    $modes = @()
    $mode = New-Object TouchAiDisplay+DEVMODE
    $mode.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mode)

    for ($index = 0; $index -lt 1000; $index += 1) {
        if (-not [TouchAiDisplay]::EnumDisplaySettings($null, $index, [ref] $mode)) {
            break
        }

        if ($mode.dmPelsWidth -ge 1280 -and $mode.dmPelsHeight -ge 900) {
            $modes += $mode
        }

        $mode.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mode)
    }

    return $modes
}

function Select-DisplayMode {
    param([object[]] $Modes)

    $preferred = $Modes |
        Where-Object { $_.dmPelsWidth -eq 1920 -and $_.dmPelsHeight -eq 1080 } |
        Select-Object -First 1

    if ($preferred) {
        return $preferred
    }

    return $Modes |
        Sort-Object { $_.dmPelsWidth * $_.dmPelsHeight } |
        Select-Object -First 1
}

function Set-ResolutionWithModule {
    if (-not (Get-Command Set-DisplayResolution -ErrorAction SilentlyContinue)) {
        Import-Module DisplayResolution -ErrorAction SilentlyContinue
    }

    if (-not (Get-Command Set-DisplayResolution -ErrorAction SilentlyContinue)) {
        return $false
    }

    try {
        Set-DisplayResolution -Width 1920 -Height 1080 -Force
        return $true
    } catch {
        Write-Host "DisplayResolution module failed: $($_.Exception.Message)"
        return $false
    }
}

function Set-ResolutionWithWin32 {
    $modes = @(Get-UsableDisplayModes)
    $mode = Select-DisplayMode -Modes $modes

    if (-not $mode) {
        return $false
    }

    $mode.dmFields = 0x80000 -bor 0x100000
    $result = [TouchAiDisplay]::ChangeDisplaySettings([ref] $mode, 0)

    if ($result -ne 0) {
        Write-Host "ChangeDisplaySettings returned $result for $($mode.dmPelsWidth)x$($mode.dmPelsHeight)"
        return $false
    }

    return $true
}

Add-Type -AssemblyName System.Windows.Forms

function Get-PrimaryDisplayBounds {
    return [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
}

function Export-DisplaySize {
    param([object] $Bounds)

    Add-Content -Path $env:GITHUB_ENV -Value "UI_PREVIEW_DISPLAY_WIDTH=$($Bounds.Width)" -Encoding ascii
    Add-Content -Path $env:GITHUB_ENV -Value "UI_PREVIEW_DISPLAY_HEIGHT=$($Bounds.Height)" -Encoding ascii
    Write-Host "display: $($Bounds.Width)x$($Bounds.Height)"
}

$changed = Set-ResolutionWithModule

if ($changed) {
    Start-Sleep -Seconds 2
    $bounds = Get-PrimaryDisplayBounds

    if ($bounds.Width -ge 1280 -and $bounds.Height -ge 900) {
        Export-DisplaySize -Bounds $bounds
        exit 0
    }

    Write-Host "DisplayResolution left the display at $($bounds.Width)x$($bounds.Height); trying Win32"
}

$changed = Set-ResolutionWithWin32

if (-not $changed) {
    throw 'Cannot switch the hosted display to an unscaled mode at least 1280x900'
}

Start-Sleep -Seconds 2
$bounds = Get-PrimaryDisplayBounds

if ($bounds.Width -lt 1280 -or $bounds.Height -lt 900) {
    throw "Display is $($bounds.Width)x$($bounds.Height); native capture needs at least 1280x900"
}

Export-DisplaySize -Bounds $bounds
