using System.Net.NetworkInformation;

namespace UsbCellularTether.Windows;

internal static class NetworkAdapterStatsCollector
{
    public static NetworkAdapterStats CollectWintun()
    {
        var adapter = FindWintunAdapter();
        return adapter is null ? NetworkAdapterStats.Empty : Collect(adapter);
    }

    public static IReadOnlyList<NetworkAdapterStats> CollectTetherRelated()
    {
        var results = new List<NetworkAdapterStats>();
        foreach (var adapter in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (!IsTetherRelated(adapter))
            {
                continue;
            }

            results.Add(Collect(adapter));
        }

        return results;
    }

    private static NetworkInterface? FindWintunAdapter()
    {
        foreach (var adapter in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (IsWintun(adapter))
            {
                return adapter;
            }
        }

        return null;
    }

    private static bool IsWintun(NetworkInterface adapter) =>
        adapter.Name.Contains(Tun2SocksEngine.InterfaceName, StringComparison.OrdinalIgnoreCase) ||
        adapter.Description.Contains("wintun", StringComparison.OrdinalIgnoreCase);

    private static bool IsTetherRelated(NetworkInterface adapter)
    {
        if (IsWintun(adapter))
        {
            return true;
        }

        var text = adapter.Name + " " + adapter.Description;
        return text.Contains("wintun", StringComparison.OrdinalIgnoreCase) ||
               text.Contains("usb cellular", StringComparison.OrdinalIgnoreCase);
    }

    private static NetworkAdapterStats Collect(NetworkInterface adapter)
    {
        try
        {
            var properties = adapter.GetIPProperties();
            var index = properties.GetIPv4Properties()?.Index ?? properties.GetIPv6Properties()?.Index ?? -1;
            ReadIPv4(adapter, out var ipv4BytesSent, out var ipv4BytesReceived, out var ipv4UnicastSent, out var ipv4UnicastReceived,
                out var ipv4NonUnicastSent, out var ipv4NonUnicastReceived, out var ipv4DiscardOut, out var ipv4DiscardIn,
                out var ipv4ErrorsOut, out var ipv4ErrorsIn);

            return new NetworkAdapterStats(
                adapter.Name,
                adapter.Description,
                index,
                adapter.OperationalStatus,
                adapter.Speed,
                ipv4BytesSent,
                ipv4BytesReceived,
                ipv4UnicastSent,
                ipv4UnicastReceived,
                ipv4NonUnicastSent,
                ipv4NonUnicastReceived,
                ipv4DiscardOut,
                ipv4DiscardIn,
                ipv4ErrorsOut,
                ipv4ErrorsIn,
                ipv4BytesSent,
                ipv4BytesReceived,
                0,
                0);
        }
        catch (Exception ex)
        {
            ConnectionLog.Write("NET", $"Failed to read adapter {adapter.Name}: {ex.Message}");
            return NetworkAdapterStats.Empty with { Name = adapter.Name, Description = adapter.Description };
        }
    }

    private static void ReadIPv4(
        NetworkInterface adapter,
        out long bytesSent,
        out long bytesReceived,
        out long unicastSent,
        out long unicastReceived,
        out long nonUnicastSent,
        out long nonUnicastReceived,
        out long discardOut,
        out long discardIn,
        out long errorsOut,
        out long errorsIn)
    {
        bytesSent = bytesReceived = unicastSent = unicastReceived = nonUnicastSent = nonUnicastReceived = 0;
        discardOut = discardIn = errorsOut = errorsIn = 0;
        try
        {
            var ipv4 = adapter.GetIPv4Statistics();
            bytesSent = ipv4.BytesSent;
            bytesReceived = ipv4.BytesReceived;
            unicastSent = ipv4.UnicastPacketsSent;
            unicastReceived = ipv4.UnicastPacketsReceived;
            nonUnicastSent = ipv4.NonUnicastPacketsSent;
            nonUnicastReceived = ipv4.NonUnicastPacketsReceived;
            discardOut = ipv4.OutgoingPacketsDiscarded;
            discardIn = ipv4.IncomingPacketsDiscarded;
            errorsOut = ipv4.OutgoingPacketsWithErrors;
            errorsIn = ipv4.IncomingPacketsWithErrors;
        }
        catch
        {
            // Adapter may not expose IPv4 statistics.
        }
    }

}
