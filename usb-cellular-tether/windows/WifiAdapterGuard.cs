using System.Net.NetworkInformation;

namespace UsbCellularTether.Windows;

internal sealed class WifiAdapterGuard : IAsyncDisposable
{
    private static readonly string SavedAdaptersPath = Path.Combine(AppContext.BaseDirectory, "disabled-wifi-adapters.txt");
    private readonly List<string> _disabledAdapters = [];

    public async Task DisableActiveWifiAdaptersAsync(CancellationToken cancellationToken)
    {
        foreach (var adapter in GetActiveWifiAdapterNames())
        {
            ConnectionLog.Write("WIFI", $"Disabling Wi-Fi adapter \"{adapter}\".");
            var result = await ProcessRunner.RunAsync(
                "netsh.exe",
                $"interface set interface name=\"{adapter}\" admin=disabled",
                cancellationToken);
            if (result.ExitCode == 0)
            {
                _disabledAdapters.Add(adapter);
                SaveDisabledAdapter(adapter);
                ConnectionLog.Write("WIFI", $"Disabled Wi-Fi adapter \"{adapter}\".");
            }
            else
            {
                ConnectionLog.Write("WIFI", $"Failed to disable \"{adapter}\": {result.Stdout} {result.Stderr}".Trim());
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        await RestoreAdaptersAsync(_disabledAdapters, CancellationToken.None);
        _disabledAdapters.Clear();
    }

    public static async Task RestoreSavedAdaptersAsync(CancellationToken cancellationToken)
    {
        var adapters = ReadSavedAdapters();
        await RestoreAdaptersAsync(adapters, cancellationToken);
    }

    private static async Task RestoreAdaptersAsync(IReadOnlyList<string> adapters, CancellationToken cancellationToken)
    {
        if (adapters.Count == 0)
        {
            return;
        }

        foreach (var adapter in adapters.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            ConnectionLog.Write("WIFI", $"Re-enabling Wi-Fi adapter \"{adapter}\".");
            var result = await ProcessRunner.RunAsync(
                "netsh.exe",
                $"interface set interface name=\"{adapter}\" admin=enabled",
                cancellationToken);
            ConnectionLog.Write("WIFI", $"Re-enable \"{adapter}\" exit={result.ExitCode} stdout=\"{result.Stdout.Trim()}\" stderr=\"{result.Stderr.Trim()}\"");
        }

        TryDeleteSavedAdapters();
    }

    private static IReadOnlyList<string> GetActiveWifiAdapterNames()
    {
        return NetworkInterface.GetAllNetworkInterfaces()
            .Where(adapter =>
                adapter.NetworkInterfaceType == NetworkInterfaceType.Wireless80211 &&
                adapter.OperationalStatus == OperationalStatus.Up)
            .Select(adapter => adapter.Name)
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static void SaveDisabledAdapter(string adapter)
    {
        var adapters = ReadSavedAdapters()
            .Append(adapter)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        File.WriteAllLines(SavedAdaptersPath, adapters);
    }

    private static IReadOnlyList<string> ReadSavedAdapters()
    {
        return File.Exists(SavedAdaptersPath)
            ? File.ReadAllLines(SavedAdaptersPath).Where(line => !string.IsNullOrWhiteSpace(line)).ToArray()
            : [];
    }

    private static void TryDeleteSavedAdapters()
    {
        try
        {
            File.Delete(SavedAdaptersPath);
        }
        catch
        {
            // Best effort; a later Restore Internet click will retry.
        }
    }
}
