namespace UsbCellularTether.Windows;

internal static class WintunAdapterLabel
{
    private const string FriendlyAlias = "USB Cellular Link";

    public static async Task TryApplyFriendlyLabelAsync(CancellationToken cancellationToken)
    {
        try
        {
            var result = await ProcessRunner.RunAsync(
                "netsh.exe",
                $"interface set interface name=\"{Tun2SocksEngine.InterfaceName}\" newname=\"{FriendlyAlias}\"",
                cancellationToken);
            if (result.ExitCode == 0)
            {
                ConnectionLog.Write("NET", $"Renamed adapter to \"{FriendlyAlias}\".");
                return;
            }

            ConnectionLog.Write(
                "NET",
                $"Could not rename wintun adapter (exit {result.ExitCode}): {result.Stdout} {result.Stderr}".Trim());
        }
        catch (Exception ex)
        {
            ConnectionLog.Write("NET", $"Adapter rename skipped: {ex.Message}");
        }
    }
}
