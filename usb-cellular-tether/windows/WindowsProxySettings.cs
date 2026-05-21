using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace UsbCellularTether.Windows;

internal sealed class WindowsProxySettings
{
    private const string InternetSettingsPath = @"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    private ProxySnapshot? _snapshot;

    public void EnableLocalProxy(int port)
    {
        _snapshot ??= Capture();

        using var key = Registry.CurrentUser.OpenSubKey(InternetSettingsPath, writable: true)
            ?? throw new InvalidOperationException("Unable to open Windows internet settings registry key.");

        key.SetValue("ProxyEnable", 1, RegistryValueKind.DWord);
        key.SetValue("ProxyServer", FormatLocalProxy(port), RegistryValueKind.String);
        RefreshSystemProxy();
    }

    public void Restore()
    {
        if (_snapshot is null) return;

        using var key = Registry.CurrentUser.OpenSubKey(InternetSettingsPath, writable: true)
            ?? throw new InvalidOperationException("Unable to open Windows internet settings registry key.");

        key.SetValue("ProxyEnable", _snapshot.ProxyEnable, RegistryValueKind.DWord);
        if (_snapshot.ProxyServer is null)
        {
            key.DeleteValue("ProxyServer", throwOnMissingValue: false);
        }
        else
        {
            key.SetValue("ProxyServer", _snapshot.ProxyServer, RegistryValueKind.String);
        }

        RefreshSystemProxy();
        _snapshot = null;
    }

    public static bool ClearIfLocalProxy(int port)
    {
        using var key = Registry.CurrentUser.OpenSubKey(InternetSettingsPath, writable: true)
            ?? throw new InvalidOperationException("Unable to open Windows internet settings registry key.");

        var proxyEnable = key.GetValue("ProxyEnable") is int enabled ? enabled : 0;
        var proxyServer = key.GetValue("ProxyServer") as string;
        if (!string.Equals(proxyServer, FormatLocalProxy(port), StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (proxyEnable == 1)
        {
            key.SetValue("ProxyEnable", 0, RegistryValueKind.DWord);
        }
        key.DeleteValue("ProxyServer", throwOnMissingValue: false);
        RefreshSystemProxy();
        return true;
    }

    private static ProxySnapshot Capture()
    {
        using var key = Registry.CurrentUser.OpenSubKey(InternetSettingsPath, writable: false)
            ?? throw new InvalidOperationException("Unable to open Windows internet settings registry key.");

        var proxyEnable = key.GetValue("ProxyEnable") is int enabled ? enabled : 0;
        var proxyServer = key.GetValue("ProxyServer") as string;
        return new ProxySnapshot(proxyEnable, proxyServer);
    }

    internal static string FormatLocalProxy(int port) => $"127.0.0.1:{port}";

    private static void RefreshSystemProxy()
    {
        InternetSetOption(IntPtr.Zero, INTERNET_OPTION_SETTINGS_CHANGED, IntPtr.Zero, 0);
        InternetSetOption(IntPtr.Zero, INTERNET_OPTION_REFRESH, IntPtr.Zero, 0);
    }

    [DllImport("wininet.dll", SetLastError = true)]
    private static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);

    private const int INTERNET_OPTION_SETTINGS_CHANGED = 39;
    private const int INTERNET_OPTION_REFRESH = 37;

    private sealed record ProxySnapshot(int ProxyEnable, string? ProxyServer);
}
